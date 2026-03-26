#!/usr/bin/env python3
"""
Decade Tagger — hook + task backend for Stash.

Year certainty rules (in priority order):
  1. scene.date is set (scraped or manually entered) → certain
  2. A 4-digit year (1900-2099) appears in the filename surrounded by
     recognised delimiters: ( ) [ ] . _ - or start/end of stem → certain
  3. Anything else → skip, do NOT tag

Decade tag format: Filmed-1990s, Filmed-1980s, etc.

On each hook/task run:
  - If year is uncertain   → do nothing (existing tags untouched)
  - If year is certain     → ensure exactly one Filmed-XXXX tag on the scene;
                             remove any other Filmed-XXXX tags that were wrong

Loop-safety: after we set the correct tag the scene already has it, so the
next Scene.Update.Post call returns ALREADY and does no write → no loop.
"""

import sys, json, re, os, time
import urllib.request

# ── Year extraction ───────────────────────────────────────────────────────────

# Matches a 4-digit year 1900-2099 surrounded by a delimiter or string edge.
# Groups: (year)
_YEAR_PAT = re.compile(
    r'(?:^|[\s._\-\[\(])'
    r'((?:19|20)\d{2})'
    r'(?:$|[\s._\-\]\)])'
)

# Tag name pattern for decade tags we manage
_DECADE_RE = re.compile(r'^Filmed-(\d{4})s$')


def _year_from_date(date_str):
    """Extract year int from 'YYYY-MM-DD' or 'YYYY'. Returns int or None."""
    if not date_str:
        return None
    try:
        y = int(str(date_str)[:4])
        if 1900 <= y <= 2099:
            return y
    except (ValueError, TypeError):
        pass
    return None


def _year_from_path(path):
    """Extract year from filename stem if flanked by delimiters."""
    stem = os.path.splitext(os.path.basename(path))[0]
    m = _YEAR_PAT.search(stem)
    if m:
        return int(m.group(1))
    return None


def get_certain_year(scene):
    """
    Return (year, source) if we are certain of the filming year,
    else return (None, None).
    """
    # Priority 1 — scraped / manually set date
    y = _year_from_date(scene.get('date'))
    if y:
        return y, 'date'
    # Priority 2 — filename
    for f in scene.get('files', []):
        y = _year_from_path(f.get('path', ''))
        if y:
            return y, 'filename'
    return None, None


def decade_tag_name(year):
    return f"Filmed-{(year // 10) * 10}s"


# ── GraphQL client ────────────────────────────────────────────────────────────

def build_client(conn):
    base = f"{conn['Scheme']}://{conn['Host']}:{conn['Port']}/graphql"
    cookie = conn.get('SessionCookie', {})
    cookie_str = f"{cookie.get('Name', '')}={cookie.get('Value', '')}"

    def gql(query, variables=None):
        body = json.dumps({"query": query, "variables": variables or {}}).encode()
        req  = urllib.request.Request(
            base, data=body,
            headers={"Content-Type": "application/json", "Cookie": cookie_str}
        )
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = json.loads(resp.read())
        if "errors" in data:
            raise RuntimeError(data["errors"])
        return data["data"]

    return gql


# ── GraphQL queries / mutations ───────────────────────────────────────────────

Q_FIND_SCENE = """
query FindScene($id: ID!) {
  findScene(id: $id) {
    id date
    tags { id name }
    files { path }
  }
}"""

Q_FIND_SCENES_PAGE = """
query FindScenesPage($page: Int!) {
  findScenes(filter: { per_page: 100, page: $page, sort: "id" }) {
    count
    scenes {
      id date
      tags { id name }
      files { path }
    }
  }
}"""

Q_FIND_TAG = """
query FindTag($name: String!) {
  findTags(
    tag_filter: { name: { value: $name, modifier: EQUALS } }
    filter: { per_page: 1 }
  ) {
    tags { id name }
  }
}"""

M_TAG_CREATE = """
mutation TagCreate($name: String!) {
  tagCreate(input: { name: $name }) { id name }
}"""

M_SCENE_UPDATE_TAGS = """
mutation SceneUpdateTags($id: ID!, $tag_ids: [ID!]!) {
  sceneUpdate(input: { id: $id, tag_ids: $tag_ids }) { id }
}"""


# ── Tag cache ─────────────────────────────────────────────────────────────────

_tag_cache = {}

def ensure_tag(gql, name):
    """Return tag id, creating the tag if it doesn't exist yet."""
    if name in _tag_cache:
        return _tag_cache[name]
    result = gql(Q_FIND_TAG, {"name": name})
    tags = result["findTags"]["tags"]
    if tags:
        tid = tags[0]["id"]
    else:
        tid = gql(M_TAG_CREATE, {"name": name})["tagCreate"]["id"]
        print(f"  Created tag: {name}", flush=True)
    _tag_cache[name] = tid
    return tid


# ── Core logic ────────────────────────────────────────────────────────────────

def process_scene(gql, scene):
    """
    Apply or fix the decade tag on a single scene.
    Returns a short status string.
    """
    year, source = get_certain_year(scene)
    if not year:
        return "SKIP"            # uncertain year — leave the scene untouched

    target    = decade_tag_name(year)
    target_id = ensure_tag(gql, target)

    current_tag_ids  = [t['id']   for t in scene.get('tags', [])]
    stale_decade_ids = [t['id']   for t in scene.get('tags', [])
                        if _DECADE_RE.match(t['name']) and t['name'] != target]

    # Nothing to do if correct tag already present and no stale ones
    if target_id in current_tag_ids and not stale_decade_ids:
        return "ALREADY"

    # Build new tag-id list: remove stale decades, add target
    new_ids = [tid for tid in current_tag_ids if tid not in stale_decade_ids]
    if target_id not in new_ids:
        new_ids.append(target_id)

    gql(M_SCENE_UPDATE_TAGS, {"id": scene["id"], "tag_ids": new_ids})

    action = "FIXED" if stale_decade_ids else "TAGGED"
    return f"{action} → {target}  (from {source})"


# ── Hook handler ──────────────────────────────────────────────────────────────

def handle_hook(gql, scene_id):
    result = gql(Q_FIND_SCENE, {"id": scene_id})
    scene  = result.get("findScene")
    if not scene:
        print(f"Scene {scene_id} not found", flush=True)
        return
    status = process_scene(gql, scene)
    print(f"[hook] Scene {scene_id} ({scene.get('date','no-date')}): {status}",
          flush=True)


# ── Retag task ────────────────────────────────────────────────────────────────

def handle_retag(gql):
    print("Re-Decade All Scenes — scanning...", flush=True)
    page = 1
    total  = None
    applied = already = skipped = errors = 0

    while True:
        result = gql(Q_FIND_SCENES_PAGE, {"page": page})
        data   = result["findScenes"]
        if total is None:
            total = data["count"]
            print(f"Total scenes: {total}", flush=True)

        scenes = data["scenes"]
        if not scenes:
            break

        for scene in scenes:
            try:
                status = process_scene(gql, scene)
                if   status == "SKIP":    skipped += 1
                elif status == "ALREADY": already  += 1
                else:
                    applied += 1
                    print(f"  [{scene['id']:>6}] {scene.get('date',''):10}  {status}",
                          flush=True)
            except Exception as e:
                errors += 1
                print(f"  ERROR scene {scene['id']}: {e}", flush=True)

        page += 1
        time.sleep(0.05)   # be gentle on the server

    print(f"\n{'='*50}", flush=True)
    print(f"Applied/Fixed : {applied}",   flush=True)
    print(f"Already OK    : {already}",   flush=True)
    print(f"Skipped (uncertain year) : {skipped}", flush=True)
    print(f"Errors        : {errors}",    flush=True)


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    raw = sys.stdin.read()
    try:
        inp = json.loads(raw)
    except Exception as e:
        print(f"ERROR: could not parse stdin JSON: {e}", flush=True)
        sys.exit(1)

    conn = inp.get("server_connection", {})
    args = inp.get("args", {})
    gql  = build_client(conn)

    # ── Task mode
    if args.get("mode") == "retag":
        handle_retag(gql)
        return

    # ── Hook mode
    ctx      = args.get("hookContext", {})
    scene_id = ctx.get("id")
    if scene_id:
        handle_hook(gql, str(scene_id))
    else:
        print("No hookContext.id — nothing to do", flush=True)


if __name__ == "__main__":
    main()
