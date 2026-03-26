#!/usr/bin/env python3
import csv
import datetime
import json
import os
import re
import sys
import urllib.parse
import urllib.request
import unicodedata
from html import unescape

DEFAULT_TIMEOUT = 20
DEFAULT_NAME_COLUMN = "name"
PLUGIN_ID = "opie_vintagePerformerImport"

Q_CONFIGURATION = """
query Configuration($include: [ID!]) {
  configuration {
    plugins(include: $include)
  }
}
"""

Q_FIND_PERFORMERS = """
query FindPerformers($name: String!) {
  findPerformers(
    performer_filter: { name: { value: $name, modifier: EQUALS } }
    filter: { per_page: 5 }
  ) {
    performers { id name url details image_path }
  }
}
"""

M_PERFORMER_CREATE = """
mutation PerformerCreate($name: String!) {
  performerCreate(input: { name: $name }) { id name }
}
"""

M_PERFORMER_UPDATE = """
mutation PerformerUpdate($input: PerformerUpdateInput!) {
  performerUpdate(input: $input) { id name }
}
"""


def log(msg, err=False):
    payload = {"output": str(msg), "error": str(msg) if err else ""}
    print(json.dumps(payload), flush=True)


def _arg_value(value):
    if not isinstance(value, dict):
        return value
    for key in ("str", "i", "b", "f"):
        if value.get(key) is not None:
            return value[key]
    if value.get("a") is not None:
        return [_arg_value(v) for v in value["a"]]
    if value.get("o") is not None:
        return {entry.get("key"): _arg_value(entry.get("value")) for entry in value["o"]}
    return None


def normalize_args(raw_args):
    if isinstance(raw_args, dict):
        return raw_args
    if isinstance(raw_args, list):
        return {
            item.get("key"): _arg_value(item.get("value"))
            for item in raw_args
            if isinstance(item, dict) and item.get("key")
        }
    return {}


def to_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    if isinstance(value, (int, float)):
        return bool(value)
    s = str(value).strip().lower()
    if s in {"1", "true", "yes", "y", "on"}:
        return True
    if s in {"0", "false", "no", "n", "off"}:
        return False
    return default


def norm_name(name):
    s = unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode("ascii")
    s = re.sub(r"[^a-zA-Z0-9\s]", " ", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def clean_text(html):
    txt = re.sub(r"(?is)<script.*?>.*?</script>", " ", html)
    txt = re.sub(r"(?is)<style.*?>.*?</style>", " ", txt)
    txt = re.sub(r"(?s)<[^>]+>", " ", txt)
    txt = unescape(txt)
    txt = txt.replace("\xa0", " ")
    return re.sub(r"\s+", " ", txt).strip()


def build_client(conn):
    base = f"{conn['Scheme']}://{conn['Host']}:{conn['Port']}/graphql"
    cookie = conn.get("SessionCookie", {})
    cookie_str = f"{cookie.get('Name', '')}={cookie.get('Value', '')}"

    def gql(query, variables=None):
        body = json.dumps({"query": query, "variables": variables or {}}).encode()
        req = urllib.request.Request(
            base,
            data=body,
            headers={"Content-Type": "application/json", "Cookie": cookie_str},
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
        if "errors" in data:
            raise RuntimeError(data["errors"])
        return data["data"]

    return gql


def load_plugin_settings(gql):
    try:
        cfg = gql(Q_CONFIGURATION, {"include": [PLUGIN_ID]}).get("configuration", {})
        plugins = cfg.get("plugins", {})
        if isinstance(plugins, dict):
            return plugins.get(PLUGIN_ID) or {}
    except Exception as e:
        log(f"Settings load warning: {e}")
    return {}


def http_get(url, timeout):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; opie_vintagePerformerImport/0.1)",
            "Accept": "text/html,application/xhtml+xml",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def parse_csg_toplist(html):
    # Match each linked thumbnail cell that contains profile URL + image + alt name.
    pat = re.compile(
        r"<a\s+href=['\"](?P<profile>https?://[^'\"]*starid-\d+\.html)['\"][^>]*>\s*"
        r"<img\s+[^>]*src=['\"](?P<img>https?://[^'\"]+)['\"][^>]*"
        r"alt=['\"](?P<alt>[^'\"]+?)\s+at\s+CockSuckersGuide\.com['\"]",
        re.IGNORECASE,
    )

    rank_by_profile = {}
    for rm in re.finditer(r"<a\s+href=['\"](?P<profile>https?://[^'\"]*starid-\d+\.html)['\"][^>]*>.*?Rank\s*#\s*(?P<rank>\d+)", html, re.IGNORECASE | re.DOTALL):
        rank_by_profile[rm.group("profile")] = int(rm.group("rank"))
    for rm in re.finditer(r"<a\s+href=['\"](?P<profile>https?://[^'\"]*starid-\d+\.html)['\"][^>]*>.*?#\s*(?P<rank>\d+)\s*:\s*&nbsp;", html, re.IGNORECASE | re.DOTALL):
        rank_by_profile[rm.group("profile")] = int(rm.group("rank"))

    out = {}
    for m in pat.finditer(html):
        name = unescape(m.group("alt")).strip()
        profile = m.group("profile").strip()
        image = m.group("img").strip()
        key = norm_name(name)
        if not key:
            continue
        rank = rank_by_profile.get(profile)
        if key not in out:
            out[key] = {
                "name": name,
                "profile_url": profile,
                "image_url": image,
                "rank": rank,
            }
    return out


def extract_profile_stats(profile_html):
    text = clean_text(profile_html)
    fields = {
        "Birthdate": r"\bBirth(?:\s*Date|date)?\s*[:\-]\s*([A-Za-z0-9, ]{3,40})",
        "Birthplace": r"\bBirth(?:\s*Place|place)?\s*[:\-]\s*([A-Za-z0-9,.'\- ]{3,60})",
        "Height": r"\bHeight\s*[:\-]\s*([A-Za-z0-9\s'\"\.\-/]{2,30})",
        "Weight": r"\bWeight\s*[:\-]\s*([A-Za-z0-9\s\.\-/]{2,20})",
        "Hair Color": r"\bHair\s*Color\s*[:\-]\s*([A-Za-z ]{3,20})",
        "Eye Color": r"\bEye\s*Color\s*[:\-]\s*([A-Za-z ]{3,20})",
        "Ethnicity": r"\bEthnicity\s*[:\-]\s*([A-Za-z ]{3,30})",
        "Tattoos": r"\bTattoos\s*[:\-]\s*([A-Za-z0-9,.'\- ]{2,80})",
        "Piercings": r"\bPiercings\s*[:\-]\s*([A-Za-z0-9,.'\- ]{2,80})",
    }

    stats = {}
    for label, pattern in fields.items():
        m = re.search(pattern, text, re.IGNORECASE)
        if m:
            stats[label] = m.group(1).strip(" .")
    return stats


def read_names_from_text(names_text):
    names = []
    for line in (names_text or "").splitlines():
        n = line.strip()
        if n:
            names.append(n)
    return names


def read_names_from_csv(csv_path, col_name):
    if not csv_path:
        return []
    if not os.path.exists(csv_path):
        log(f"CSV path not found: {csv_path}", err=True)
        return []

    names = []
    with open(csv_path, "r", encoding="utf-8", errors="replace", newline="") as f:
        reader = csv.DictReader(f)
        for row in reader:
            v = (row.get(col_name) or "").strip()
            if v:
                names.append(v)
    return names


def uniq_names(names):
    seen = set()
    out = []
    for n in names:
        key = norm_name(n)
        if key and key not in seen:
            seen.add(key)
            out.append(n.strip())
    return out


def find_performer(gql, name):
    data = gql(Q_FIND_PERFORMERS, {"name": name})
    items = data.get("findPerformers", {}).get("performers", [])
    if not items:
        return None
    for p in items:
        if norm_name(p.get("name", "")) == norm_name(name):
            return p
    return items[0]


def create_performer(gql, name):
    return gql(M_PERFORMER_CREATE, {"name": name})["performerCreate"]


def update_performer(gql, update_input):
    return gql(M_PERFORMER_UPDATE, {"input": update_input})["performerUpdate"]


def build_details_block(source_url, source_name, profile_url, rank, stats):
    lines = ["[Vintage Import]", f"Source: {source_name}"]
    if source_url:
        lines.append(f"Source List: {source_url}")
    if profile_url:
        lines.append(f"Profile: {profile_url}")
    if rank:
        lines.append(f"Rank: #{rank}")
    if stats:
        lines.append("Stats:")
        for k, v in stats.items():
            lines.append(f"- {k}: {v}")
    lines.append(f"Imported: {datetime.datetime.utcnow().isoformat()}Z")
    return "\n".join(lines)


def merge_details(existing, block, overwrite):
    if overwrite or not existing:
        return block
    if "[Vintage Import]" in (existing or ""):
        # Replace previous import section to avoid duplication.
        pre = existing.split("[Vintage Import]")[0].rstrip()
        return (pre + "\n\n" + block).strip()
    return (existing.rstrip() + "\n\n" + block).strip()


def parse_source_entries(source_url, timeout):
    if not source_url:
        return {}
    html = http_get(source_url, timeout)
    host = urllib.parse.urlparse(source_url).netloc.lower()
    if "cocksuckersguide.com" in host:
        return parse_csg_toplist(html)
    log(f"No specialized parser for source host {host}; will import names only")
    return {}


def main():
    payload = json.loads(sys.stdin.read())
    args = normalize_args(payload.get("args", {}))
    conn = payload.get("server_connection", {})
    gql = build_client(conn)

    settings = load_plugin_settings(gql)

    mode = args.get("mode", "import")
    if mode != "import":
        log(f"Unsupported mode: {mode}")
        return

    source_url = args.get("source_url") or settings.get("sourceListUrl") or ""
    source_name = urllib.parse.urlparse(source_url).netloc or "source"

    names_text = args.get("names_text") or settings.get("namesText") or ""
    csv_path = args.get("csv_path") or settings.get("csvPath") or ""
    csv_col = args.get("csv_name_column") or settings.get("csvNameColumn") or DEFAULT_NAME_COLUMN

    update_existing = to_bool(args.get("update_existing", settings.get("updateExisting")), default=True)
    overwrite_details = to_bool(args.get("overwrite_details", settings.get("overwriteDetails")), default=False)
    overwrite_image = to_bool(args.get("overwrite_image", settings.get("overwriteImage")), default=False)
    dry_run = to_bool(args.get("dry_run", settings.get("dryRun")), default=False)
    timeout = int(args.get("timeout_seconds") or settings.get("timeoutSeconds") or DEFAULT_TIMEOUT)

    names = read_names_from_text(names_text)
    if not names:
        names = read_names_from_csv(csv_path, csv_col)
    names = uniq_names(names)

    if not names:
        log("No performer names found. Provide namesText or csvPath/csvNameColumn.", err=True)
        return

    log(f"Import start: names={len(names)} source={source_url or 'none'} dry_run={dry_run}")

    source_entries = {}
    if source_url:
        try:
            source_entries = parse_source_entries(source_url, timeout)
            log(f"Source entries parsed: {len(source_entries)}")
        except Exception as e:
            log(f"Source fetch/parse failed: {e}", err=True)

    counts = {"created": 0, "updated": 0, "skipped": 0, "errors": 0}

    for idx, name in enumerate(names, start=1):
        try:
            key = norm_name(name)
            source = source_entries.get(key, {})
            profile_url = source.get("profile_url")
            image_url = source.get("image_url")
            rank = source.get("rank")

            stats = {}
            if profile_url:
                try:
                    profile_html = http_get(profile_url, timeout)
                    stats = extract_profile_stats(profile_html)
                except Exception as e:
                    log(f"[{idx}/{len(names)}] {name}: profile fetch failed ({e})")

            performer = find_performer(gql, name)
            performer_preexisted = performer is not None
            if not performer:
                if dry_run:
                    log(f"[{idx}/{len(names)}] DRY create performer: {name}")
                    counts["created"] += 1
                    continue
                performer = create_performer(gql, name)
                performer = find_performer(gql, name) or performer
                counts["created"] += 1
                log(f"[{idx}/{len(names)}] Created performer: {name}")
            else:
                log(f"[{idx}/{len(names)}] Found performer: {performer.get('name')}")

            if performer_preexisted and not update_existing:
                counts["skipped"] += 1
                continue

            if not performer or "id" not in performer:
                counts["errors"] += 1
                log(f"[{idx}/{len(names)}] Could not resolve performer id for {name}", err=True)
                continue

            detail_block = build_details_block(source_url, source_name, profile_url, rank, stats)
            merged_details = merge_details(performer.get("details", ""), detail_block, overwrite_details)

            update_input = {"id": performer["id"]}

            if profile_url and (not performer.get("url") or performer.get("url") != profile_url):
                update_input["url"] = profile_url

            if merged_details and (overwrite_details or merged_details != (performer.get("details") or "")):
                update_input["details"] = merged_details

            has_image = bool(performer.get("image_path"))
            if image_url and (overwrite_image or not has_image):
                update_input["image"] = image_url

            if len(update_input) == 1:
                counts["skipped"] += 1
                continue

            if dry_run:
                log(f"[{idx}/{len(names)}] DRY update {name}: keys={list(update_input.keys())}")
                counts["updated"] += 1
                continue

            update_performer(gql, update_input)
            counts["updated"] += 1
            log(f"[{idx}/{len(names)}] Updated performer: {name}")

        except Exception as e:
            counts["errors"] += 1
            log(f"[{idx}/{len(names)}] ERROR {name}: {e}", err=True)

    log(
        "Import done — "
        f"created={counts['created']} updated={counts['updated']} "
        f"skipped={counts['skipped']} errors={counts['errors']}"
    )


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        log(f"Fatal error: {e}", err=True)
        sys.exit(1)
