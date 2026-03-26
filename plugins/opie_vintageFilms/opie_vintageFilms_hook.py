#!/usr/bin/env python3
"""
Vintage Films — hook + task backend for Stash.

Mode A  (full-film in one file):
  Scene file lives directly in /Gay/Vintage/ or in a decade subfolder
  (1970s, 1980s, 1990s, 2000s).  The filename encodes the movie title.
  One Movie record is created (or found) and the scene is linked to it.

Mode B  (multi-scene film):
  Scene file lives inside a named subfolder of /Gay/Vintage/ (anything
  that is NOT a decade folder or @eaDir).  The FOLDER NAME encodes the
  movie title.  All scenes in the same folder share one Movie record and
  get sequential scene_index values derived from the leading digit in the
  filename (e.g. "3_Hitchhiker_...mkv" → scene_index=3).

TPDB lookup:
  The cleaned title + year are searched on api.theporndb.net/movies.
  The best match (exact title preferred, then highest score) is used for
  cover image, description, director and studio.  If nothing is found on
  TPDB the Movie record is still created with what we know.

Loop-safety:
  The hook checks whether the scene is already linked to a Movie and
  exits immediately if so (no write → no re-trigger).
"""

import sys, json, re, os, time, unicodedata
import urllib.request, urllib.parse
import http.cookiejar

# ── Constants ─────────────────────────────────────────────────────────────────

DEFAULT_VINTAGE_ROOT = "/data/stash/Gay/Vintage"  # path INSIDE the container
DECADE_FOLDERS = {"1960s", "1970s", "1980s", "1990s", "2000s", "2010s"}
SKIP_FOLDERS   = {"@eaDir", "Thumbs.db"}

TPDB_API_KEY   = os.environ.get("TPDB_API_KEY", "K5qjgcWrrKSwYTJqFhKIqfuOjen1wc4JVefFaVfp08b965c7")
TPDB_BASE      = "https://api.theporndb.net"
IMPORT_URL_HOSTS = ("gaydvdempire.com", "adultempire.com", "theporndb.net")
AEBN_BASE = "https://gay.aebn.com"
AEBN_SEARCH_URL = "https://gay.aebn.com/gay/search?queryType=Free+Form&query="
AEBN_MOBILE_BASE = "https://m.aebn.net"

# Match preference: gay first, bi second, straight last.
_GAY_HINTS = {
    "gay", "all male", "all-male", "male only", "man on man", "man-on-man",
    "msm", "homo", "homosexual", "twink", "bear", "daddy", "leather"
}
_BI_HINTS = {
    "bi", "bisexual", "bi-sexual", "mmf", "mfm", "biflex", "switch"
}
_STRAIGHT_HINTS = {
    "straight", "hetero", "heterosexual", "girl", "girls", "woman", "women",
    "female", "lesbian", "milf", "teen girl", "shemale"
}

# ── Filename cleaning ─────────────────────────────────────────────────────────

# Noise tokens to strip from filenames/foldernames before parsing
_NOISE = [
    # quality / encoding tags
    r'starlight\s*ai\s*upscaled?', r'ai[\s\-]*up(?:scaled?)?', r'ai[\s\-]*upscale?',
    r'remastered?', r'\d+p', r'dvd5[\s\-]*remux', r'dvd5', r'dvdr', r'blu[\s\-]*ray',
    r'bluray', r'hd', r'full\s*hd', r'4k', r'bdremux', r'remux',
    # release / format flags
    r'dvd\s*ripped?\s*raw', r'dvd', r'vhs', r'rip', r'vhsrip',
    # personal flags used in filenames
    r'\bct\b', r'\bfh\b', r'\baum\b', r'no\s*ct',
    # source site garbage
    r'porn\s*video\s*gay\s*txxx\s*com', r'gay\s*porn\s*video\s*[\-–]?\s*thegay\s*com',
    r'watch\s*vintage\s*xxx\s*videos.*', r'watch\s*classic\s*xxx\s*videos.*',
    r'most\s*popular\s*retro\s*porn.*', r'super[\s\-]*hot\s*(vintage|retro|classic)\s*porn.*',
    r'best\s*(vintage|classic|retro)\s*porn.*', r'uncensored\s*(retro|classic|vintage)\s*porn.*',
    r'full\s*(length|uncut)\s*(vintage|retro|classic)\s*(porn|flick|film|movie).*',
    r'uncut\s*retro\s*porn.*', r'manporn\.xxx.*', r'gaybostube.*', r'gaytxxx.*',
    r'upornia.*', r'zenporn.*',
    # resolution/platform artifacts at end
    r'[\-–]\s*\d+p$',
]
_NOISE_RE = re.compile(
    '|'.join(_NOISE),
    re.IGNORECASE
)

# Catalog numbers like Fvp003, Fvp056
_CATALOG_RE = re.compile(r'\bF[a-z]{1,3}\d{3,4}\b', re.IGNORECASE)

# Year pattern — 4 digits 1900–2099 with delimiters
_YEAR_RE = re.compile(r'(?:^|[\s._\-\[\(])((?:19|20)\d{2})(?:$|[\s._\-\]\)])')

# Leading scene-index number in filename  e.g. "3_Title..." or "3. Title..."
_IDX_RE = re.compile(r'^(\d+)[_.\s\-]+')

# Studio in trailing brackets: short (≤40 chars), no comma (not a cast list),
# no 4-digit year (not a "context" paren), at end of string
_STUDIO_BRACKET_RE = re.compile(r'[\[\(]([^\]\),]{1,40})[\]\)]\s*$')

# Studio in leading brackets: short (≤40 chars), no comma, at start of string
_STUDIO_BRACKET_LEAD_RE = re.compile(r'^[\[\(]([^\]\),]{1,40})[\]\)]')

# All bracket groups (for cleanup after year/studio extraction)
_ALL_BRACKETS_RE = re.compile(r'[\[\(][^\]\)]*[\]\)]')


def _normalize(s):
    """Lower-case, collapse whitespace, strip punctuation for comparison."""
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode()
    s = re.sub(r'[^\w\s]', ' ', s.lower())
    return re.sub(r'\s+', ' ', s).strip()


def _collect_text(value):
    """Flatten nested candidate data into one text blob for keyword checks."""
    out = []
    if isinstance(value, dict):
        for v in value.values():
            out.append(_collect_text(v))
    elif isinstance(value, list):
        for v in value:
            out.append(_collect_text(v))
    elif value is not None:
        out.append(str(value))
    return " ".join([x for x in out if x])


def _abs_url(u):
    if not u:
        return None
    if u.startswith("//"):
        return "https:" + u
    return u


def _orientation_bias(candidate):
    """Return an orientation bias score for candidate ranking.

    Positive score means more likely a gay title, negative score means likely
    straight/women-centric.
    """
    txt = _normalize(_collect_text(candidate))
    if not txt:
        return 0

    score = 0
    for kw in _GAY_HINTS:
        if kw in txt:
            score += 12
    for kw in _BI_HINTS:
        if kw in txt:
            score += 5
    for kw in _STRAIGHT_HINTS:
        if kw in txt:
            score -= 14
    return score


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


def _clean_name(raw):
    """
    Strip noise from a filename stem or folder name.
    Returns (cleaned_title, year_int_or_None, studio_str_or_None).
    """
    s = raw

    # 1. Normalise separators early so word-boundary patterns work correctly
    s = s.replace('_', ' ')
    s = re.sub(r'[\-–]', ' ', s)

    # 2. Extract year (first 4-digit year with delimiters)
    year = None
    m = _YEAR_RE.search(s)
    if m:
        year = int(m.group(1))
        s = s[:m.start(1)] + s[m.end(1):]

    # 3. Extract studio from a short bracket (no commas = not a cast list).
    #    Accept brackets at the START or END of the string (e.g. [Catalina] Title
    #    or Title [Bijou Video]).
    studio = None
    # Try trailing bracket first, then leading
    sm = _STUDIO_BRACKET_RE.search(s)
    if not sm:
        sm = _STUDIO_BRACKET_LEAD_RE.match(s)
    if sm:
        candidate = sm.group(1).strip()
        if not re.search(r'(?:19|20)\d{2}', candidate) and len(candidate) <= 40:
            studio = candidate
        s = s[:sm.start()] + s[sm.end():]

    # 4. Strip any remaining bracket groups (cast notes, context)
    s = _ALL_BRACKETS_RE.sub(' ', s)

    # 5. Strip noise patterns
    s = _NOISE_RE.sub(' ', s)
    s = _CATALOG_RE.sub(' ', s)

    # 6. Final cleanup
    s = re.sub(r'\s+', ' ', s).strip()
    s = s.strip(' .,;:-')

    return s, year, studio


# ── Mode detection ────────────────────────────────────────────────────────────

def classify_scene(scene, vintage_root):
    """
    Returns ('A', title, year, studio, None) for single-file full films
         or ('B', title, year, studio, scene_index) for multi-scene folder
         or (None, ...) if scene is not under VINTAGE_ROOT.
    """
    paths = [f['path'] for f in scene.get('files', []) if f.get('path')]
    if not paths:
        return None, None, None, None, None

    path = paths[0]

    # Must be under vintage root
    if not path.startswith(vintage_root + "/") and path != vintage_root:
        return None, None, None, None, None

    rel = path[len(vintage_root):].lstrip("/")
    parts = rel.split("/")

    if len(parts) == 1:
        # Directly in Vintage root → Mode A
        stem = os.path.splitext(parts[0])[0]
        title, year, studio = _clean_name(stem)
        return 'A', title, year, studio, None

    parent = parts[0]

    if parent in DECADE_FOLDERS:
        # In a decade subfolder → Mode A
        stem = os.path.splitext(parts[-1])[0]
        title, year, studio = _clean_name(stem)
        return 'A', title, year, studio, None

    if parent in SKIP_FOLDERS or parent.startswith('@'):
        return None, None, None, None, None

    # Named subfolder → Mode B
    folder_title, folder_year, folder_studio = _clean_name(parent)
    filename = os.path.splitext(parts[-1])[0]
    scene_index = None
    idx_m = _IDX_RE.match(filename)
    if idx_m:
        scene_index = int(idx_m.group(1))
    return 'B', folder_title, folder_year, folder_studio, scene_index


# ── TPDB search ───────────────────────────────────────────────────────────────

def _tpdb_request(path, params=None):
    url = TPDB_BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url,
        headers={"Authorization": f"Bearer {TPDB_API_KEY}", "Accept": "application/json"}
    )
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            return json.loads(r.read())
    except Exception as e:
        log(f"TPDB request error: {e}")
        return None


def search_tpdb_movie(title, year, studio=None):
    """
    Search TPDB for a movie by title (+ optional year filter).
    Returns the best matching data dict or None.
    """
    if not title:
        return None

    resp = _tpdb_request("/movies", {"q": title, "per_page": 10})
    if not resp or not resp.get("data"):
        return None

    candidates = resp["data"]
    norm_title = _normalize(title)
    norm_studio = _normalize(studio) if studio else None
    title_words = set(norm_title.split())

    best = None
    best_score = -1
    for c in candidates:
        c_title = _normalize(c.get("title", ""))
        c_studio = _normalize(((c.get("site") or {}).get("name", "")))
        c_words = set(c_title.split())
        overlap = len(title_words & c_words)
        if not overlap:
            continue

        c_year = None
        if c.get("date"):
            try:
                c_year = int(str(c["date"])[:4])
            except (ValueError, TypeError):
                pass

        if c_title == norm_title:
            score = 100
        else:
            score = overlap * 12
            if norm_title in c_title or c_title in norm_title:
                score += 8

        if year:
            if not c_year:
                score -= 20
            else:
                delta = abs(c_year - year)
                if year < 1985 and c_year >= 1990:
                    continue
                if delta == 0:
                    score += 45
                elif delta <= 1:
                    score += 20
                elif delta <= 3:
                    score += 5
                elif year < 1985 and delta > 5:
                    continue
                elif delta <= 10:
                    score -= 40
                else:
                    continue

        if norm_studio:
            if c_studio == norm_studio:
                score += 25
            elif norm_studio in c_studio or c_studio in norm_studio:
                score += 10
            elif c_studio:
                score -= 12

        # Strongly bias toward gay matches, allow bi, avoid straight/women hits.
        score += _orientation_bias(c)

        if score > best_score:
            best_score = score
            best = c

    if best_score >= 35:
        return best
    return None


# ── AEBN search/scrape ───────────────────────────────────────────────────────

_AEBN_OPENER = None


def _get_aebn_opener():
    global _AEBN_OPENER
    if _AEBN_OPENER is None:
        jar = http.cookiejar.CookieJar()
        _AEBN_OPENER = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    return _AEBN_OPENER


def _aebn_fetch(url, timeout=25):
    opener = _get_aebn_opener()
    parsed = urllib.parse.urlparse(url)
    # Pass age gate once for requested path.
    gate_path = parsed.path + (("?" + parsed.query) if parsed.query else "")
    gate_url = AEBN_BASE + "/avs/gate-redirect?f=" + urllib.parse.quote(gate_path, safe="")
    try:
        gate_req = urllib.request.Request(gate_url, headers={"User-Agent": "Mozilla/5.0"})
        opener.open(gate_req, timeout=timeout).read()
    except Exception:
        pass

    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0", "Accept": "text/html"})
    with opener.open(req, timeout=timeout) as r:
        return r.read().decode("utf-8", errors="replace")


def _parse_year_from_date(text):
    if not text:
        return None
    m = re.search(r'(19|20)\d{2}', text)
    if m:
        return int(m.group(0))
    return None


def parse_aebn_movie_page(html, url):
    data = {"url": url, "title": None, "year": None, "studio": None, "front_image": None, "back_image": None, "categories": [], "performers": []}

    tm = re.search(r'<title>\s*Watch\s+(.+?)\s*\|\s*Gay\s*\|\s*AEBN\s*</title>', html, re.IGNORECASE)
    if tm:
        data["title"] = tm.group(1).strip()
    if not data["title"]:
        tm2 = re.search(r'<title>\s*(.+?)\s*(?:\||-)+\s*AEBN\s*</title>', html, re.IGNORECASE)
        if tm2:
            data["title"] = re.sub(r'\s+', ' ', tm2.group(1)).strip()

    rm = re.search(r'Released:</span>\s*([^<]+)', html, re.IGNORECASE)
    if rm:
        data["year"] = _parse_year_from_date(rm.group(1))
    if not data["year"]:
        rm2 = re.search(r'\b(?:Released|Release Date|Released On)\b\s*[:\-]?\s*([^<\n]+)', html, re.IGNORECASE)
        if rm2:
            data["year"] = _parse_year_from_date(rm2.group(1))

    sm = re.search(r'section-detail-list-item-studio[^>]*>.*?Studio:</span>\s*<a[^>]*>([^<]+)</a>', html, re.IGNORECASE | re.DOTALL)
    if sm:
        data["studio"] = sm.group(1).strip()
    if not data["studio"]:
        sm2 = re.search(r'href=["\"](?:/gay/studios?/\d+/[^"\"]+|/studio/\d+[^"\"]*)["\"][^>]*>\s*([^<]+?)\s*</a>', html, re.IGNORECASE)
        if sm2:
            data["studio"] = sm2.group(1).strip()

    fm = re.search(r'class="dts-modal-boxcover-front"\s+src="([^"]+)"', html, re.IGNORECASE)
    bm = re.search(r'class="dts-modal-boxcover-back"\s+src="([^"]+)"', html, re.IGNORECASE)
    if fm:
        data["front_image"] = _abs_url(fm.group(1).strip())
    if bm:
        data["back_image"] = _abs_url(bm.group(1).strip())
    if not data["front_image"]:
        # Mobile pages commonly expose the box cover via the BoxCovers image path.
        fm2 = re.search(r'<img[^>]+src=["\"](https?://[^"\"]*?/BoxCovers/[^"\"]+)["\"]', html, re.IGNORECASE)
        if fm2:
            data["front_image"] = _abs_url(fm2.group(1).strip())

    cm = re.search(r'<div class="dts-detail-movie-categories-content">(.*?)</div>', html, re.IGNORECASE | re.DOTALL)
    if cm:
        cats = []
        for m in re.finditer(r'<a[^>]*>\s*([^<]+?)\s*</a>', cm.group(1), re.IGNORECASE):
            c = m.group(1).strip()
            if c and c not in cats:
                cats.append(c)
        data["categories"] = cats
    if not data["categories"]:
        cats = []
        for m in re.finditer(r'href=["\"]/search/movies/category/\d+[^"\"]*["\"][^>]*>\s*([^<]+?)\s*</a>', html, re.IGNORECASE):
            c = m.group(1).strip()
            if c and c not in cats:
                cats.append(c)
        data["categories"] = cats

    perfs = []
    # Primary: star cards carry performer name in the title attribute.
    for pm in re.finditer(
        r'dts-collection-item-star[^>]*title=["\']([^"\']+)["\'][^>]*>.*?href=["\']/gay/stars/\d+/[^"\']+["\']',
        html,
        re.IGNORECASE | re.DOTALL,
    ):
        p = pm.group(1).strip()
        if p and p not in perfs:
            perfs.append(p)

    # Fallback: pull slug from performer URL and title-case it.
    if not perfs:
        for pm in re.finditer(r'href=["\'](/gay/stars/\d+/([^"\']+))["\']', html, re.IGNORECASE):
            slug = (pm.group(2) or "").strip()
            if not slug:
                continue
            p = re.sub(r'[-_]+', ' ', slug).strip().title()
            if p and p not in perfs:
                perfs.append(p)
    # Mobile fallback: /star/<id>/... style links.
    if not perfs:
        for pm in re.finditer(r'href=["\"]/star/\d+[^"\"]*["\"][^>]*>\s*([^<]+?)\s*</a>', html, re.IGNORECASE):
            p = pm.group(1).strip()
            if p and p not in perfs:
                perfs.append(p)
    data["performers"] = perfs

    return data


def search_aebn_movie(title, year=None):
    if not title:
        return None

    search_url = AEBN_SEARCH_URL + urllib.parse.quote_plus(title)
    try:
        html = _aebn_fetch(search_url)
    except Exception as e:
        log(f"AEBN search error: {e}")
        return None

    links = []
    seen = set()
    for m in re.finditer(r'href=["\'](/gay/movies/\d+/[^"\']+)["\']', html, re.IGNORECASE):
        path = m.group(1)
        if path in seen:
            continue
        seen.add(path)
        links.append(urllib.parse.urljoin(AEBN_BASE, path))
        if len(links) >= 8:
            break

    # Mobile fallback links from m.aebn.net search pages.
    if len(links) < 8:
        for m in re.finditer(r'href=["\'](/movie/\d+[^"\']*)["\']', html, re.IGNORECASE):
            path = m.group(1)
            if path in seen:
                continue
            seen.add(path)
            links.append(urllib.parse.urljoin(AEBN_MOBILE_BASE, path))
            if len(links) >= 8:
                break

    if not links:
        return None

    norm_title = _normalize(title)
    best = None
    best_score = -1
    for link in links:
        try:
            page = _aebn_fetch(link)
            cand = parse_aebn_movie_page(page, link)
        except Exception:
            continue

        c_title = _normalize(cand.get("title") or "")
        if not c_title:
            continue

        if c_title == norm_title:
            score = 100
        else:
            t_words = set(norm_title.split())
            c_words = set(c_title.split())
            overlap = len(t_words & c_words)
            if not overlap:
                continue
            score = overlap * 12
            if norm_title in c_title or c_title in norm_title:
                score += 8

        c_year = cand.get("year")
        if year and c_year:
            delta = abs(c_year - year)
            if delta == 0:
                score += 30
            elif delta <= 1:
                score += 12
            elif delta <= 3:
                score += 4
            else:
                score -= 20

        # Prefer older editions when title ties are ambiguous.
        if c_year:
            if c_year <= 1995:
                score += 18
            elif c_year <= 2005:
                score += 10
            elif c_year <= 2010:
                score += 6
            elif c_year >= 2020:
                score -= 6

        if cand.get("categories"):
            score += 6
        if cand.get("performers"):
            score += 6

        if score > best_score:
            best_score = score
            best = cand

    if best_score >= 30:
        return best
    return None


def fetch_aebn_movie_by_url(url):
    if not url:
        return None
    try:
        html = _aebn_fetch(url)
        return parse_aebn_movie_page(html, url)
    except Exception as e:
        log(f"AEBN URL fetch error: {e}")
        return None


def extract_scene_aebn_url(scene):
    for entry in scene.get("urls", []) or []:
        if isinstance(entry, dict):
            u = entry.get("url")
        else:
            u = entry
        if not u:
            continue
        lu = str(u).lower()
        if "gay.aebn.com/gay/movies/" in lu or "m.aebn.net/movie/" in lu:
            return str(u)
    return None


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

Q_FIND_SCENE_QUICK = """
query FindSceneQuick($id: ID!) {
  findScene(id: $id) {
    id
    movies { movie { id } }
    files { path }
  }
}"""

Q_FIND_SCENE = """
query FindScene($id: ID!) {
  findScene(id: $id) {
    id title date studio { id name }
                urls { url }
        tags { id name }
        performers { id name }
    movies { movie { id name } scene_index }
    files { path }
  }
}"""

Q_FIND_VINTAGE_SCENES_PAGE = """
query FindVintageScenesPage($page: Int!, $root: String!) {
  findScenes(
        scene_filter: { path: { value: $root, modifier: INCLUDES } }
    filter: { per_page: 50, page: $page, sort: "id" }
  ) {
    count
    scenes {
      id title date studio { id name }
                        urls { url }
            tags { id name }
            performers { id name }
      movies { movie { id name } scene_index }
      files { path }
    }
  }
}"""

Q_FIND_MOVIES = """
query FindMovies($name: String!) {
  findMovies(
    movie_filter: { name: { value: $name, modifier: EQUALS } }
    filter: { per_page: 5 }
  ) {
    movies { id name date }
  }
}"""

Q_FIND_MOVIE = """
query FindMovie($id: ID!) {
  findMovie(id: $id) {
    id name date url synopsis director
    front_image_path back_image_path
    studio { id name }
    scenes {
            id title date studio { id name }
            urls { url }
      movies { movie { id name } scene_index }
      files { path }
    }
  }
}"""

Q_CONFIGURATION = """
query Configuration {
    configuration {
        plugins
    }
}"""

Q_FIND_STUDIO = """
query FindStudios($name: String!) {
  findStudios(
    studio_filter: { name: { value: $name, modifier: EQUALS } }
    filter: { per_page: 3 }
  ) {
    studios { id name }
  }
}"""

Q_FIND_TAG = """
query FindTag($name: String!) {
    findTags(tag_filter: { name: { value: $name, modifier: EQUALS } }, filter: { per_page: 1 }) {
        tags { id name }
    }
}"""

M_TAG_CREATE = """
mutation TagCreate($name: String!) {
    tagCreate(input: { name: $name }) { id name }
}"""

Q_FIND_PERFORMERS = """
query FindPerformers($name: String!) {
    findPerformers(performer_filter: { name: { value: $name, modifier: EQUALS } }, filter: { per_page: 5 }) {
        performers { id name }
    }
}"""

M_PERFORMER_CREATE = """
mutation PerformerCreate($name: String!) {
    performerCreate(input: { name: $name }) { id name }
}"""

M_MOVIE_CREATE = """
mutation MovieCreate($input: MovieCreateInput!) {
  movieCreate(input: $input) { id name }
}"""

M_MOVIE_UPDATE = """
mutation MovieUpdate($input: MovieUpdateInput!) {
  movieUpdate(input: $input) { id name }
}"""

M_SCENE_UPDATE = """
mutation SceneUpdate($input: SceneUpdateInput!) {
  sceneUpdate(input: $input) { id }
}"""


# ── Stash helpers ─────────────────────────────────────────────────────────────

def find_or_create_movie(gql, name, year, studio_id, tpdb_data):
    """Find an existing Movie by exact name, or create one. Returns movie_id."""
    result = gql(Q_FIND_MOVIES, {"name": name})
    movies = result.get("findMovies", {}).get("movies", [])

    # Try to find a match by name + optional year
    for m in movies:
        m_year = None
        if m.get("date"):
            try:
                m_year = int(str(m["date"])[:4])
            except (ValueError, TypeError):
                pass
        if year and m_year and abs(m_year - year) > 2:
            continue
        log(f"  → Found existing Movie: '{m['name']}' (id={m['id']})")
        return m["id"]

    # Not found — create it
    inp = {"name": name}
    if year:
        inp["date"] = f"{year}-01-01"
    if studio_id:
        inp["studio_id"] = studio_id
    if tpdb_data:
        if tpdb_data.get("description"):
            inp["synopsis"] = tpdb_data["description"]
        if tpdb_data.get("url"):
            inp["url"] = tpdb_data["url"]
        # Director — try to extract from performers list tagged as director
        # TPDB doesn't have a top-level director field, but some do
        if tpdb_data.get("director"):
            inp["director"] = tpdb_data["director"]
        # Cover image
        img = (tpdb_data.get("image") or
               tpdb_data.get("poster") or
               (tpdb_data.get("posters") or {}).get("full"))
        if img:
            inp["front_image"] = img
        back = (tpdb_data.get("back_image") or
                (tpdb_data.get("background_back") or {}).get("full"))
        if back:
            inp["back_image"] = back

    r = gql(M_MOVIE_CREATE, {"input": inp})
    movie_id = r["movieCreate"]["id"]
    log(f"  → Created Movie: '{name}' (id={movie_id})")
    return movie_id


def find_studio_id(gql, studio_name):
    """Returns the Stash studio ID for the given name, or None."""
    if not studio_name:
        return None
    result = gql(Q_FIND_STUDIO, {"name": studio_name})
    studios = result.get("findStudios", {}).get("studios", [])
    if studios:
        return studios[0]["id"]
    return None


_tag_cache = {}
_performer_cache = {}


def ensure_tag_id(gql, name):
    if not name:
        return None
    if name in _tag_cache:
        return _tag_cache[name]
    r = gql(Q_FIND_TAG, {"name": name})
    tags = r.get("findTags", {}).get("tags", [])
    if tags:
        tid = tags[0]["id"]
    else:
        tid = gql(M_TAG_CREATE, {"name": name})["tagCreate"]["id"]
    _tag_cache[name] = tid
    return tid


def ensure_performer_id(gql, name):
    if not name:
        return None
    key = _normalize(name)
    if key in _performer_cache:
        return _performer_cache[key]
    r = gql(Q_FIND_PERFORMERS, {"name": name})
    perfs = r.get("findPerformers", {}).get("performers", [])
    found = None
    for p in perfs:
        if _normalize(p.get("name", "")) == key:
            found = p
            break
    if not found and perfs:
        found = perfs[0]
    if found:
        pid = found["id"]
    else:
        pid = gql(M_PERFORMER_CREATE, {"name": name})["performerCreate"]["id"]
    _performer_cache[key] = pid
    return pid


def merge_scene_people_and_tags(gql, scene, category_tags, performer_names):
    tag_ids = [t["id"] for t in scene.get("tags", []) if t.get("id")]
    performer_ids = [p["id"] for p in scene.get("performers", []) if p.get("id")]

    changed = False
    for cat in category_tags or []:
        tid = ensure_tag_id(gql, cat)
        if tid and tid not in tag_ids:
            tag_ids.append(tid)
            changed = True

    for pname in performer_names or []:
        pid = ensure_performer_id(gql, pname)
        if pid and pid not in performer_ids:
            performer_ids.append(pid)
            changed = True

    if not changed:
        return

    gql(M_SCENE_UPDATE, {"input": {"id": scene["id"], "tag_ids": tag_ids, "performer_ids": performer_ids}})
    log(f"  → Updated scene {scene['id']} with AEBN tags/performers")


def apply_aebn_movie_metadata(gql, movie_id, aebn_data, title=None, year=None, studio_id=None):
    if not aebn_data:
        return
    inp = {"id": movie_id}
    if title:
        inp["name"] = title
    if year:
        inp["date"] = f"{year}-01-01"
    if studio_id:
        inp["studio_id"] = studio_id
    if aebn_data.get("url"):
        inp["url"] = aebn_data["url"]
    if aebn_data.get("front_image"):
        inp["front_image"] = aebn_data["front_image"]
    if aebn_data.get("back_image"):
        inp["back_image"] = aebn_data["back_image"]
    if len(inp) > 1:
        gql(M_MOVIE_UPDATE, {"input": inp})
        log(f"  → Applied AEBN metadata to movie {movie_id}")


def apply_cover_metadata(gql, movie_id, aebn_data=None, tpdb_data=None):
    """Update movie covers/URL only, leaving title/year untouched."""
    inp = {"id": movie_id}

    if aebn_data:
        if aebn_data.get("url"):
            inp["url"] = aebn_data["url"]
        if aebn_data.get("front_image"):
            inp["front_image"] = aebn_data["front_image"]
        if aebn_data.get("back_image"):
            inp["back_image"] = aebn_data["back_image"]

    if tpdb_data and "front_image" not in inp:
        img = tpdb_data.get("image") or tpdb_data.get("poster") or (tpdb_data.get("posters") or {}).get("full")
        back = tpdb_data.get("back_image") or (tpdb_data.get("background_back") or {}).get("full")
        if tpdb_data.get("url") and "url" not in inp:
            inp["url"] = tpdb_data["url"]
        if img:
            inp["front_image"] = img
        if back:
            inp["back_image"] = back

    if len(inp) > 1:
        gql(M_MOVIE_UPDATE, {"input": inp})
        log(f"  → Scraped missing cover for movie {movie_id}")
        return True
    return False


def scrape_missing_covers(gql, vintage_root):
    """Scrape cover art for linked vintage movies missing a front cover."""
    page = 1
    seen_movies = set()
    counts = {"UPDATED": 0, "HAS_COVER": 0, "NO_MATCH": 0, "SKIP": 0, "ERROR": 0}

    while True:
        result = gql(Q_FIND_VINTAGE_SCENES_PAGE, {"page": page, "root": vintage_root})
        data = result["findScenes"]
        scenes = data["scenes"]
        if not scenes:
            break

        for scene in scenes:
            for sm in scene.get("movies", []):
                movie_id = sm["movie"]["id"]
                if movie_id in seen_movies:
                    continue
                seen_movies.add(movie_id)

                try:
                    movie = gql(Q_FIND_MOVIE, {"id": movie_id}).get("findMovie")
                    if not movie:
                        counts["SKIP"] += 1
                        continue
                    if movie.get("front_image_path"):
                        counts["HAS_COVER"] += 1
                        continue

                    mode, title, year, film_studio, scene_index = classify_scene(scene, vintage_root)
                    if not mode or not title:
                        counts["SKIP"] += 1
                        continue

                    studio_name = film_studio or (scene.get("studio") or {}).get("name") or (movie.get("studio") or {}).get("name")
                    studio_id = find_studio_id(gql, studio_name) or ((scene.get("studio") or {}).get("id")) or ((movie.get("studio") or {}).get("id"))

                    aebn_url = extract_scene_aebn_url(scene)
                    if not aebn_url:
                        murl = (movie.get("url") or "").lower()
                        if "gay.aebn.com/gay/movies/" in murl:
                            aebn_url = movie.get("url")

                    if aebn_url:
                        aebn = fetch_aebn_movie_by_url(aebn_url)
                    else:
                        aebn = search_aebn_movie(title, year)

                    tpdb = None
                    if not (aebn and aebn.get("front_image")):
                        tpdb = search_tpdb_movie(title, year, studio_name)

                    changed = apply_cover_metadata(gql, movie_id, aebn, tpdb)
                    if changed:
                        counts["UPDATED"] += 1
                        if aebn:
                            # Also sync scene categories/performers when available from AEBN.
                            merge_scene_people_and_tags(gql, scene, aebn.get("categories", []), aebn.get("performers", []))
                            if studio_id or year or title:
                                apply_aebn_movie_metadata(gql, movie_id, aebn, title, year, studio_id)
                    else:
                        counts["NO_MATCH"] += 1

                except Exception as e:
                    counts["ERROR"] += 1
                    log(f"  ERROR scrape movie {movie_id}: {e}")

        page += 1

    return counts


def link_scene_to_movie(gql, scene_id, movie_id, scene_index, existing_movies):
    """
    Add this movie link to the scene's existing movie list.
    existing_movies is the list from scene.movies.
    """
    # Build the new list preserving existing links
    movies_input = []
    for sm in existing_movies:
        movies_input.append({
            "movie_id": sm["movie"]["id"],
            "scene_index": sm.get("scene_index")
        })
    # Add the new link if not already present
    for sm in existing_movies:
        if sm["movie"]["id"] == movie_id:
            log(f"  → Scene {scene_id} already linked to movie {movie_id}")
            return
    movies_input.append({"movie_id": movie_id, "scene_index": scene_index})

    gql(M_SCENE_UPDATE, {"input": {"id": scene_id, "movies": movies_input}})
    log(f"  → Linked scene {scene_id} → movie {movie_id} (idx={scene_index})")


def build_movie_update_input(movie_id, name, year, studio_id, tpdb_data):
    inp = {"id": movie_id}
    if name:
        inp["name"] = name
    if year:
        inp["date"] = f"{year}-01-01"
    if studio_id:
        inp["studio_id"] = studio_id
    if not tpdb_data:
        return inp
    if tpdb_data.get("description"):
        inp["synopsis"] = tpdb_data["description"]
    if tpdb_data.get("url"):
        inp["url"] = tpdb_data["url"]
    directors = tpdb_data.get("directors") or []
    director_name = tpdb_data.get("director") or (directors[0].get("name") if directors else None)
    if director_name:
        inp["director"] = director_name
    img = (
        tpdb_data.get("image") or
        tpdb_data.get("poster") or
        (tpdb_data.get("posters") or {}).get("full")
    )
    if img:
        inp["front_image"] = img
    back = tpdb_data.get("back_image") or (tpdb_data.get("background_back") or {}).get("full")
    if back:
        inp["back_image"] = back
    return inp


def update_movie_metadata(gql, movie_id, name, year, studio_id, tpdb_data):
    inp = build_movie_update_input(movie_id, name, year, studio_id, tpdb_data)
    gql(M_MOVIE_UPDATE, {"input": inp})
    return inp


def clear_suspicious_movie_metadata(gql, movie):
    current_url = (movie.get("url") or "").lower()
    if not any(host in current_url for host in IMPORT_URL_HOSTS):
        return False

    inp = {"id": movie["id"], "url": ""}
    changed = True
    if movie.get("front_image_path") and "default=true" not in movie["front_image_path"]:
        inp["front_image"] = ""
    if movie.get("back_image_path"):
        inp["back_image"] = ""
    if movie.get("synopsis"):
        inp["synopsis"] = ""
    if movie.get("director"):
        inp["director"] = ""

    if changed:
        gql(M_MOVIE_UPDATE, {"input": inp})
        log(f"  → Cleared suspicious imported metadata for movie {movie['id']}")
        return True
    return False


def load_plugin_settings(gql):
    try:
        cfg = gql(Q_CONFIGURATION).get("configuration", {})
        plugins = cfg.get("plugins", {})
        if not isinstance(plugins, dict):
            return {}

        # Be tolerant of key casing/prefix differences across installs.
        candidates = ["vintageFilms", "opie_vintageFilms", "VintageFilms", "vintagefilms"]
        for key in candidates:
            val = plugins.get(key)
            if isinstance(val, dict):
                return val

        for key, val in plugins.items():
            normalized = str(key).lower().replace("_", "")
            if normalized in {"vintagefilms", "opievintagefilms"} and isinstance(val, dict):
                return val
    except Exception as e:
        log(f"Settings load warning: {e}")
    return {}


def get_vintage_root(gql, args):
    root = None

    # Task args can override setting for one-off runs.
    if isinstance(args, dict):
        root = args.get("vintage_root") or args.get("vintageRoot")

    if not root:
        settings = load_plugin_settings(gql)
        root = settings.get("vintageRoot") or settings.get("vintage_root")

    if not root or not isinstance(root, str):
        root = DEFAULT_VINTAGE_ROOT

    # Normalize so path prefix checks are stable.
    root = root.rstrip("/") or DEFAULT_VINTAGE_ROOT
    return root


def repair_movie_metadata(gql, movie_id, vintage_root, scene=None):
    movie = gql(Q_FIND_MOVIE, {"id": movie_id}).get("findMovie")
    if not movie:
        return "SKIP"

    representative = scene
    if representative is None:
        for candidate in movie.get("scenes", []):
            mode, title, year, studio, scene_index = classify_scene(candidate, vintage_root)
            if mode and title:
                representative = candidate
                break
    if not representative:
        log(f"  Movie {movie_id}: no representative vintage scene found")
        return "SKIP"

    mode, title, year, film_studio, scene_index = classify_scene(representative, vintage_root)
    if not mode or not title:
        return "SKIP"

    studio_name = film_studio or (representative.get("studio") or {}).get("name") or (movie.get("studio") or {}).get("name")
    studio_id = find_studio_id(gql, studio_name) or ((representative.get("studio") or {}).get("id")) or ((movie.get("studio") or {}).get("id"))

    log(f"  Repair movie {movie_id}: title='{title}' year={year} studio='{studio_name}'")
    tpdb = search_tpdb_movie(title, year, studio_name)
    if tpdb:
        final_title = title
        tpdb_title = tpdb.get("title") or ""
        if len(tpdb_title) > len(final_title):
            final_title = tpdb_title
        if not year and tpdb.get("date"):
            try:
                year = int(str(tpdb["date"])[:4])
            except (ValueError, TypeError):
                pass
        update_movie_metadata(gql, movie_id, final_title, year, studio_id, tpdb)
        log(f"  → Repaired movie {movie_id} with TPDB '{tpdb.get('title','')}' ({tpdb.get('date','')})")
        return "UPDATED"

    if clear_suspicious_movie_metadata(gql, movie):
        return "CLEARED"
    log(f"  → No safe TPDB match for movie {movie_id}")
    return "NO_MATCH"


# ── Core processing ───────────────────────────────────────────────────────────

def process_scene(gql, scene, vintage_root):
    """Process a single scene. Returns 'LINKED', 'SKIP', 'ALREADY', or 'ERROR'."""
    mode, title, year, film_studio, scene_index = classify_scene(scene, vintage_root)

    if mode is None:
        return "SKIP"

    # Already linked?
    if scene.get("movies"):
        return "ALREADY"

    if not title:
        log(f"  Scene {scene['id']}: could not parse title from path — skip")
        return "SKIP"

    log(f"  Scene {scene['id']}: Mode={mode} title='{title}' year={year} studio='{film_studio}' idx={scene_index}")

    # Resolve studio
    studio_id = None
    if film_studio:
        studio_id = find_studio_id(gql, film_studio)
    if not studio_id and scene.get("studio"):
        studio_id = scene["studio"]["id"]

    # TPDB lookup
    tpdb = search_tpdb_movie(title, year, film_studio or (scene.get("studio") or {}).get("name"))
    aebn_url = extract_scene_aebn_url(scene)
    if aebn_url:
        log(f"    AEBN direct URL: {aebn_url}")
        aebn = fetch_aebn_movie_by_url(aebn_url)
    else:
        aebn = search_aebn_movie(title, year)
    if aebn:
        log(f"    AEBN match: '{aebn.get('title','')}' ({aebn.get('year')})")
        if not studio_id and aebn.get("studio"):
            studio_id = find_studio_id(gql, aebn.get("studio"))
        if not year and aebn.get("year"):
            year = aebn.get("year")

    if tpdb:
        log(f"    TPDB match: '{tpdb['title']}' ({tpdb.get('date','')})")
        # Use TPDB title if it looks better (more complete)
        tpdb_title = tpdb["title"]
        if len(tpdb_title) > len(title):
            final_title = tpdb_title
        else:
            final_title = title
        # If TPDB gave us a year and we didn't have one
        if not year and tpdb.get("date"):
            try:
                year = int(str(tpdb["date"])[:4])
            except (ValueError, TypeError):
                pass
    else:
        log(f"    No TPDB match found")
        final_title = title

    movie_id = find_or_create_movie(gql, final_title, year, studio_id, tpdb)
    if aebn:
        apply_aebn_movie_metadata(gql, movie_id, aebn, final_title, year, studio_id)
    link_scene_to_movie(gql, scene["id"], movie_id, scene_index, scene.get("movies", []))
    if aebn:
        merge_scene_people_and_tags(gql, scene, aebn.get("categories", []), aebn.get("performers", []))
    return "LINKED"


# ── Logging ───────────────────────────────────────────────────────────────────

def log(msg):
    print(json.dumps({"output": msg, "error": ""}), flush=True)


# ── Entry point ───────────────────────────────────────────────────────────────

def main():
    payload = json.loads(sys.stdin.read())
    conn    = payload.get("server_connection", {})
    args    = normalize_args(payload.get("args", {}))
    mode    = args.get("mode", "hook")

    gql = build_client(conn)
    vintage_root = get_vintage_root(gql, args)
    log(f"Using vintage root: {vintage_root}")

    if mode == "process_all":
        page     = 1
        total    = None
        counts   = {"LINKED": 0, "SKIP": 0, "ALREADY": 0, "ERROR": 0}

        while True:
            try:
                result = gql(Q_FIND_VINTAGE_SCENES_PAGE, {"page": page, "root": vintage_root})
                data   = result["findScenes"]
            except Exception as e:
                log(f"  ERROR loading vintage scenes page {page}: {e}")
                counts["ERROR"] += 1
                break
            if total is None:
                total = data["count"]
                log(f"Processing vintage films — {total} vintage scenes found")

            scenes = data["scenes"]
            if not scenes:
                break

            for scene in scenes:
                try:
                    status = process_scene(gql, scene, vintage_root)
                    counts[status] = counts.get(status, 0) + 1
                except Exception as e:
                    log(f"  ERROR scene {scene.get('id')}: {e}")
                    counts["ERROR"] += 1
            page += 1

        log(f"Done — LINKED={counts['LINKED']} ALREADY={counts['ALREADY']} SKIP={counts['SKIP']} ERROR={counts['ERROR']}")

    elif mode == "repair_all":
        page = 1
        total = None
        seen_movies = set()
        counts = {"UPDATED": 0, "CLEARED": 0, "NO_MATCH": 0, "SKIP": 0, "ERROR": 0}

        while True:
            try:
                result = gql(Q_FIND_VINTAGE_SCENES_PAGE, {"page": page, "root": vintage_root})
                data = result["findScenes"]
            except Exception as e:
                log(f"  ERROR loading vintage scenes page {page}: {e}")
                counts["ERROR"] += 1
                break
            if total is None:
                total = data["count"]
                log(f"Repairing vintage metadata — {total} vintage scenes found")

            scenes = data["scenes"]
            if not scenes:
                break

            for scene in scenes:
                for sm in scene.get("movies", []):
                    movie_id = sm["movie"]["id"]
                    if movie_id in seen_movies:
                        continue
                    seen_movies.add(movie_id)
                    try:
                        status = repair_movie_metadata(gql, movie_id, vintage_root, scene)
                        counts[status] = counts.get(status, 0) + 1
                    except Exception as e:
                        log(f"  ERROR movie {movie_id}: {e}")
                        counts["ERROR"] += 1
            page += 1

        log(
            "Done — "
            f"UPDATED={counts['UPDATED']} CLEARED={counts['CLEARED']} "
            f"NO_MATCH={counts['NO_MATCH']} SKIP={counts['SKIP']} ERROR={counts['ERROR']}"
        )

    elif mode == "repair_movie":
        movie_id = args.get("movie_id")
        if not movie_id:
            log("Repair movie: missing movie_id")
            return
        try:
            status = repair_movie_metadata(gql, str(movie_id), vintage_root)
            log(f"Movie {movie_id}: {status}")
        except Exception as e:
            log(f"Movie {movie_id}: ERROR — {e}")

    elif mode == "scrape_missing_covers":
        try:
            counts = scrape_missing_covers(gql, vintage_root)
        except Exception as e:
            log(f"Scrape missing covers: ERROR — {e}")
            return
        log(
            "Done — "
            f"UPDATED={counts['UPDATED']} HAS_COVER={counts['HAS_COVER']} "
            f"NO_MATCH={counts['NO_MATCH']} SKIP={counts['SKIP']} ERROR={counts['ERROR']}"
        )

    else:
        scene_id = (args.get("hookContext") or {}).get("id")
        if not scene_id:
            return

        try:
            # Quick fetch: just path + existing movies to short-circuit non-vintage scenes
            quick = gql(Q_FIND_SCENE_QUICK, {"id": scene_id})
            quick_scene = quick.get("findScene")
            if not quick_scene:
                return
            paths = [f["path"] for f in quick_scene.get("files", []) if f.get("path")]
            if not paths or not paths[0].startswith(vintage_root + "/"):
                return  # not a vintage scene — exit fast
            if quick_scene.get("movies"):
                return  # already linked — exit fast

            # Full fetch only for genuine vintage scenes that need processing
            result = gql(Q_FIND_SCENE, {"id": scene_id})
            scene  = result.get("findScene")
            if not scene:
                return

            status = process_scene(gql, scene, vintage_root)
            log(f"Scene {scene_id}: {status}")
        except Exception as e:
            msg = f"Scene {scene_id}: ERROR — {e}"
            print(json.dumps({"output": msg, "error": msg}), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        import traceback
        tb = traceback.format_exc()
        log(f"Fatal error: {e}")
        log(tb)
