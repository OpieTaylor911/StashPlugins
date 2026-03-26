/**
 * Vintage Films — UI
 *
 * 1. Adds a "🎬 VintageFilms" navbar item with a dropdown showing all vintage films,
 *    plus a "Gallery" button to open a full-screen modal grid view.
 *
 * 2. Gallery modal displays cover art in a responsive grid with:
 *    - Click to open film in Stash's movie editor
 *    - Drag-and-drop upload for cover image
 *    - Studio and year metadata on hover
 *
 * 3. Adds a "🎬" badge overlay to scene cards where the scene is already
 *    linked to a Movie, so you can see at a glance which scenes are full films.
 */
(function () {
    'use strict';

    if (window._vintageFilmsUILoaded) return;
    window._vintageFilmsUILoaded = true;

    const API = window.location.origin + '/graphql';
    const PLUGIN_CONFIG_ID = 'opie_vintageFilms';
    const PLUGIN_CONFIG_IDS = ['opie_vintageFilms', 'vintageFilms'];
    const PLUGIN_TASK_IDS = ['opie_vintageFilms', 'vintageFilms'];
    const TASK_REPAIR = 'Repair Vintage Metadata';
    const DEFAULT_VINTAGE_ROOT = '/data/stash/Gay/Vintage';

    // ── GraphQL ──────────────────────────────────────────────────────────────
    async function gql(query, variables, options = {}) {
        const resp = await fetch(API, {
            method     : 'POST',
            headers    : { 'Content-Type': 'application/json' },
            body       : JSON.stringify({ query, variables }),
            credentials: 'include',
        });
        const payload = await resp.json();
        if (payload.errors?.length) {
            console.error('[vintage-films] GraphQL error', payload.errors);
            if (options.throwOnError) {
                const msg = payload.errors.map((e) => e?.message || String(e)).join(' | ');
                throw new Error(msg || 'GraphQL request failed');
            }
        }
        return payload.data;
    }

    const Q_MOVIES = `
    query FindMovies($page: Int!) {
      findMovies(filter: { per_page: 100, page: $page, sort: "date", direction: DESC }) {
        count
                movies { id name date studio { name } front_image_path scenes { id } }
      }
    }`;

    // Fetch all movies (paginated) sorted by date DESC
    async function fetchAllMovies() {
        const all = [];
        let page = 1;
        while (true) {
            const data = await gql(Q_MOVIES, { page });
            const chunk = data?.findMovies?.movies || [];
            all.push(...chunk);
            if (all.length >= (data?.findMovies?.count || 0) || !chunk.length) break;
            page++;
        }
        return all;
    }

    const Q_MOVIE = `
    query FindMovie($id: ID!) {
      findMovie(id: $id) {
        id
        name
        date
        studio { name }
        front_image_path
        scenes { id }
      }
    }`;

    const M_MOVIE_UPDATE = `
    mutation MovieUpdate($input: MovieUpdateInput!) {
      movieUpdate(input: $input) { id }
    }`;

    const M_RUN_PLUGIN_TASK = `
    mutation RunPluginTask($pluginId: ID!, $taskName: String!, $args: [PluginArgInput!]) {
      runPluginTask(plugin_id: $pluginId, task_name: $taskName, args: $args)
    }`;

        const Q_PLUGIN_CONFIG = `
        query FindPluginConfig($input: [ID!]) {
            configuration { plugins(include: $input) }
        }`;

        const M_CONFIGURE_PLUGIN = `
        mutation ConfigurePlugin($pluginId: ID!, $input: Map!) {
            configurePlugin(plugin_id: $pluginId, input: $input)
        }`;

    let navbarBuildPromise = null;

    function moviePlayHref(movie) {
        const firstSceneId = movie.scenes?.[0]?.id;
        return firstSceneId ? `/scenes/${firstSceneId}` : `/movies/${movie.id}`;
    }

    function movieEditHref(movie) {
        return `/movies/${movie.id}`;
    }

    function movieYearAndDecade(movie) {
        const year = movie.date ? Number.parseInt(movie.date.slice(0, 4), 10) : null;
        if (!year || Number.isNaN(year)) return [];
        const decade = `${Math.floor(year / 10) * 10}s`;
        return [String(year), decade];
    }

    function dedupeNavbarItems() {
        const items = Array.from(document.querySelectorAll('#vf-nav-item'));
        if (items.length <= 1) return items[0] || null;
        for (const item of items.slice(1)) item.remove();
        return items[0];
    }

    function pluginArgStr(key, value) {
        return { key, value: { str: String(value) } };
    }

    function sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    async function fetchMovie(movieId) {
        const data = await gql(Q_MOVIE, { id: movieId });
        return data?.findMovie || null;
    }

    async function runPluginTask(taskName, args = []) {
        let lastError = null;
        for (const pluginId of PLUGIN_TASK_IDS) {
            try {
                const data = await gql(M_RUN_PLUGIN_TASK, {
                    pluginId,
                    taskName,
                    args,
                });
                if (data?.runPluginTask) return data.runPluginTask;
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError || new Error(`Failed to queue task: ${taskName}`);
    }

    async function loadPluginConfig() {
        const data = await gql(Q_PLUGIN_CONFIG, { input: PLUGIN_CONFIG_IDS });
        const plugins = data?.configuration?.plugins;
        if (!plugins || typeof plugins !== 'object') return {};
        for (const pluginId of PLUGIN_CONFIG_IDS) {
            if (plugins[pluginId] && typeof plugins[pluginId] === 'object') {
                return plugins[pluginId];
            }
        }
        return {};
    }

    async function savePluginConfig(values) {
        const current = await loadPluginConfig();
        const input = { ...(current || {}), ...(values || {}) };
        await gql(M_CONFIGURE_PLUGIN, {
            pluginId: PLUGIN_CONFIG_ID,
            input,
        });
        return input;
    }

    function normalizeRootPath(raw) {
        const value = String(raw || '').trim();
        if (!value) return DEFAULT_VINTAGE_ROOT;
        return value.endsWith('/') ? value.slice(0, -1) : value;
    }

    function movieMetaText(movie) {
        const studio = movie.studio?.name || '';
        return [...movieYearAndDecade(movie), studio].filter(Boolean).join(' · ') || 'No year or studio';
    }

    function syncGalleryCard(card, movie) {
        card._movie = movie;
        card.dataset.movieId = movie.id;

        const titleEl = card.querySelector('.vf-gallery-card-title');
        const metaEl = card.querySelector('.vf-gallery-card-meta');
        if (titleEl) titleEl.textContent = movie.name;
        if (metaEl) metaEl.textContent = movieMetaText(movie);

        const currentImg = card.querySelector('img');
        const currentPlaceholder = card.querySelector('.vf-gallery-card-placeholder');
        if (movie.front_image_path) {
            if (currentImg) {
                currentImg.src = movie.front_image_path;
            } else {
                const img = document.createElement('img');
                img.src = movie.front_image_path;
                img.alt = '';
                if (currentPlaceholder) {
                    currentPlaceholder.replaceWith(img);
                } else {
                    card.insertAdjacentElement('afterbegin', img);
                }
            }
        } else if (!currentPlaceholder) {
            const placeholder = document.createElement('div');
            placeholder.className = 'vf-gallery-card-placeholder';
            placeholder.textContent = '📽️';
            if (currentImg) {
                currentImg.replaceWith(placeholder);
            } else {
                card.insertAdjacentElement('afterbegin', placeholder);
            }
        }
    }

    async function refreshMovieCard(movieId, card, attempts = 5) {
        for (let i = 0; i < attempts; i++) {
            const movie = await fetchMovie(movieId);
            if (movie) {
                syncGalleryCard(card, movie);
                if (i > 0 || movie.front_image_path) return movie;
            }
            await sleep(800);
        }
        return card._movie || null;
    }

    async function repairMovieFromTPDB(movieId, card, button) {
        const original = button.textContent;
        button.disabled = true;
        button.textContent = '...';
        try {
            await runPluginTask(TASK_REPAIR, [
                pluginArgStr('mode', 'repair_movie'),
                pluginArgStr('movie_id', movieId),
            ]);
            await refreshMovieCard(movieId, card);
            button.textContent = 'Done';
        } catch (err) {
            console.error('[vintage-films] TPDB repair failed', err);
            button.textContent = 'Err';
        } finally {
            setTimeout(() => {
                button.disabled = false;
                button.textContent = original;
            }, 1200);
        }
    }

    async function repairAllVintageMetadata(button) {
        const original = button.textContent;
        button.disabled = true;
        button.textContent = 'Queued';
        try {
            await runPluginTask(TASK_REPAIR, []);
        } catch (err) {
            console.error('[vintage-films] Bulk repair failed', err);
            button.textContent = 'Err';
            setTimeout(() => {
                button.disabled = false;
                button.textContent = original;
            }, 1200);
            return;
        }
        setTimeout(() => {
            button.disabled = false;
            button.textContent = original;
        }, 2000);
    }

    async function scrapeMissingCovers(button) {
        const original = button.textContent;
        button.disabled = true;
        button.textContent = 'Queued';
        try {
            await runPluginTask(TASK_REPAIR, [
                pluginArgStr('mode', 'scrape_missing_covers'),
            ]);
            button.textContent = 'Running';
        } catch (err) {
            console.error('[vintage-films] Missing-cover scrape failed', err);
            button.textContent = 'Err';
            setTimeout(() => {
                button.disabled = false;
                button.textContent = original;
            }, 1200);
            return;
        }
        setTimeout(() => {
            button.disabled = false;
            button.textContent = original;
        }, 2500);
    }

    // ── Styles ───────────────────────────────────────────────────────────────
    function injectStyles() {
        if (document.getElementById('vf-styles')) return;
        const s = document.createElement('style');
        s.id = 'vf-styles';
        s.textContent = `
            /* Navbar dropdown */
            #vf-nav-item {
                position: relative;
            }
            #vf-nav-item .vf-toggle {
                cursor: pointer;
                user-select: none;
                padding: 0.5rem 0.75rem;
                white-space: nowrap;
            }
            #vf-nav-item .vf-toggle:hover { opacity: 0.8; }
            #vf-dropdown {
                display: none;
                position: absolute;
                top: 100%;
                left: 0;
                background: #1b1b2f;
                border: 1px solid #444;
                border-radius: 4px;
                min-width: 320px;
                max-height: 70vh;
                overflow-y: auto;
                z-index: 9999;
                box-shadow: 0 4px 16px rgba(0,0,0,0.5);
            }
            #vf-dropdown.open { display: block; }
            #vf-dropdown a {
                display: block;
                padding: 0.4rem 0.75rem;
                color: #ccc;
                text-decoration: none;
                font-size: 0.85rem;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                border-bottom: 1px solid #2a2a45;
            }
            #vf-dropdown a:hover { background: #2a2a45; color: #fff; }
            .vf-dropdown-header {
                padding: 0.5rem 0.75rem;
                font-size: 0.75rem;
                text-transform: uppercase;
                letter-spacing: 0.08em;
                color: #888;
                border-bottom: 1px solid #333;
                display: flex;
                justify-content: space-between;
                align-items: center;
                gap: 0.5rem;
                display: flex;
                justify-content: space-between;
                align-items: center;
            }
            .vf-dropdown-header-title { flex: 1; }
            .vf-dropdown-header button {
                background: #0066cc;
                color: #fff;
                border: none;
                border-radius: 3px;
                padding: 0.25rem 0.5rem;
                font-size: 0.7rem;
                cursor: pointer;
                white-space: nowrap;
                flex-shrink: 0;
            }
            .vf-dropdown-header button:hover { background: #0052a3; }
            #vf-dropdown-search {
                width: calc(100% - 1.5rem);
                margin: 0.4rem 0.75rem;
                background: #111;
                border: 1px solid #444;
                border-radius: 3px;
                color: #ccc;
                padding: 0.3rem 0.5rem;
                font-size: 0.82rem;
            }
            /* Gallery Modal */
            #vf-modal {
                display: none;
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0,0,0,0.85);
                z-index: 10000;
                overflow-y: auto;
            }
            #vf-modal.open { display: block; }
            #vf-modal-content {
                max-width: 1600px;
                margin: 2rem auto;
                padding: 2rem;
                background: #1b1b2f;
                border-radius: 8px;
                position: relative;
            }
            .vf-modal-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 2rem;
                border-bottom: 2px solid #444;
                padding-bottom: 1rem;
                gap: 1rem;
            }
            .vf-modal-header h2 {
                margin: 0;
                color: #fff;
                font-size: 1.8rem;
            }
            .vf-modal-header-actions {
                display: flex;
                align-items: center;
                gap: 0.5rem;
                flex-wrap: wrap;
            }
            .vf-modal-root-controls {
                display: flex;
                align-items: center;
                gap: 0.4rem;
                background: rgba(0, 0, 0, 0.24);
                border: 1px solid #3a3a52;
                border-radius: 4px;
                padding: 0.35rem 0.5rem;
            }
            .vf-modal-root-label {
                color: #a9a9c8;
                font-size: 0.75rem;
                letter-spacing: 0.03em;
                white-space: nowrap;
            }
            .vf-modal-root-input {
                width: 19rem;
                max-width: 45vw;
                background: #10101c;
                border: 1px solid #4a4a64;
                color: #ddd;
                border-radius: 3px;
                padding: 0.28rem 0.45rem;
                font-size: 0.78rem;
            }
            .vf-modal-root-save,
            .vf-modal-root-default {
                color: #fff;
                border: none;
                border-radius: 3px;
                padding: 0.32rem 0.55rem;
                cursor: pointer;
                font-size: 0.72rem;
                font-weight: 700;
                white-space: nowrap;
            }
            .vf-modal-root-save { background: #2f7d32; }
            .vf-modal-root-save:hover { background: #256628; }
            .vf-modal-root-default { background: #4b5563; }
            .vf-modal-root-default:hover { background: #3b4350; }
            .vf-modal-root-status {
                color: #9ea1c7;
                font-size: 0.72rem;
                min-width: 5.5rem;
                text-align: right;
            }
            .vf-modal-cover-urls {
                background: #5c3d8a;
                color: #fff;
                border: none;
                border-radius: 4px;
                padding: 0.5rem 1rem;
                cursor: pointer;
                font-weight: bold;
            }
            .vf-modal-cover-urls:hover { background: #4a2f72; }
            .vf-modal-close,
            .vf-modal-repair-all,
            .vf-modal-scrape-missing {
                color: #fff;
                border: none;
                border-radius: 4px;
                padding: 0.5rem 1rem;
                cursor: pointer;
                font-weight: bold;
            }
            .vf-modal-close {
                background: #d32f2f;
            }
            .vf-modal-scrape-missing {
                background: #275f94;
            }
            .vf-modal-repair-all {
                background: #8a6118;
            }
            .vf-modal-close:hover { background: #b71c1c; }
            .vf-modal-scrape-missing:hover { background: #1f4d78; }
            .vf-modal-repair-all:hover { background: #6d4b12; }
            #vf-gallery-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
                gap: 1.5rem;
            }
            .vf-gallery-card {
                position: relative;
                cursor: pointer;
                overflow: hidden;
                border-radius: 6px;
                background: #111;
                box-shadow: 0 2px 8px rgba(0,0,0,0.6);
                transition: transform 0.2s, box-shadow 0.2s;
            }
            .vf-gallery-card:hover {
                transform: translateY(-4px);
                box-shadow: 0 6px 16px rgba(0,0,0,0.8);
            }
            .vf-gallery-card img {
                width: 100%;
                height: 250px;
                object-fit: cover;
                display: block;
            }
            .vf-gallery-card-placeholder {
                width: 100%;
                height: 250px;
                background: linear-gradient(135deg, #2a2a45 0%, #1a1a2e 100%);
                display: flex;
                align-items: center;
                justify-content: center;
                color: #666;
                font-size: 2rem;
            }
            .vf-gallery-card-info {
                padding: 0.75rem;
                background: #0a0a14;
                min-height: 4.5rem;
                display: flex;
                flex-direction: column;
                justify-content: center;
            }
            .vf-gallery-card-title {
                color: #fff;
                font-weight: bold;
                font-size: 0.9rem;
                margin-bottom: 0.3rem;
                word-break: break-word;
            }
            .vf-gallery-card-meta {
                color: #999;
                font-size: 0.75rem;
                line-height: 1.3;
            }
            .vf-gallery-card-actions {
                position: absolute;
                bottom: 0.5rem;
                right: 0.5rem;
                display: flex;
                gap: 0.35rem;
                z-index: 10;
                opacity: 0;
                transition: opacity 0.2s;
            }
            .vf-gallery-card:hover .vf-gallery-card-actions {
                opacity: 1;
            }
            .vf-gallery-card-btn {
                color: #fff;
                border: none;
                border-radius: 3px;
                padding: 0.3rem 0.6rem;
                font-size: 0.7rem;
                cursor: pointer;
            }
            .vf-gallery-card-btn[disabled] {
                opacity: 0.7;
                cursor: progress;
            }
            .vf-gallery-card-upload {
                background: rgba(0, 102, 204, 0.9);
            }
            .vf-gallery-card-upload:hover { background: rgba(0, 82, 163, 0.95); }
            .vf-gallery-card-repair {
                background: rgba(138, 97, 24, 0.92);
            }
            .vf-gallery-card-repair:hover { background: rgba(109, 75, 18, 0.97); }
            /* ── Cover URL Editor Modal ─────────────────────────── */
            #vf-cover-url-modal {
                display: none;
                position: fixed;
                top: 0; left: 0; right: 0; bottom: 0;
                background: rgba(0,0,0,0.87);
                z-index: 10001;
                overflow-y: auto;
            }
            #vf-cover-url-modal.open { display: block; }
            #vf-cover-url-modal-content {
                max-width: 1000px;
                margin: 2rem auto;
                padding: 2rem;
                background: #1b1b2f;
                border-radius: 8px;
                position: relative;
            }
            .vf-cover-url-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 1.5rem;
                border-bottom: 2px solid #444;
                padding-bottom: 1rem;
                gap: 0.75rem;
                flex-wrap: wrap;
            }
            .vf-cover-url-header h2 { margin: 0; color: #fff; font-size: 1.5rem; }
            .vf-cover-url-header-actions { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
            .vf-cover-url-filter {
                display: flex;
                align-items: center;
                gap: 0.35rem;
                font-size: 0.82rem;
                color: #aaa;
                user-select: none;
                cursor: pointer;
            }
            .vf-cover-url-filter input { cursor: pointer; }
            .vf-cover-url-save-all {
                background: #2f7d32;
                color: #fff;
                border: none;
                border-radius: 4px;
                padding: 0.5rem 1rem;
                cursor: pointer;
                font-weight: bold;
                font-size: 0.85rem;
                white-space: nowrap;
            }
            .vf-cover-url-save-all:hover { background: #256628; }
            .vf-cover-url-refresh {
                background: #546e7a;
                color: #fff;
                border: none;
                border-radius: 4px;
                padding: 0.5rem 1rem;
                cursor: pointer;
                font-weight: bold;
                font-size: 0.85rem;
                white-space: nowrap;
            }
            .vf-cover-url-refresh:hover { background: #455a64; }
            .vf-cover-url-close {
                background: #d32f2f;
                color: #fff;
                border: none;
                border-radius: 4px;
                padding: 0.5rem 1rem;
                cursor: pointer;
                font-weight: bold;
            }
            .vf-cover-url-close:hover { background: #b71c1c; }
            #vf-cover-url-list { display: flex; flex-direction: column; gap: 0.5rem; }
            .vf-cover-url-row {
                display: grid;
                grid-template-columns: 64px 1fr auto auto;
                align-items: center;
                gap: 0.75rem;
                background: #12121f;
                border: 1px solid #2a2a45;
                border-radius: 5px;
                padding: 0.5rem 0.75rem;
            }
            .vf-cover-url-row.has-cover { opacity: 0.6; }
            .vf-cover-url-row.has-cover:focus-within,
            .vf-cover-url-row.has-cover:hover { opacity: 1; }
            .vf-cover-url-thumb {
                width: 64px;
                height: 90px;
                object-fit: cover;
                border-radius: 3px;
                background: #2a2a45;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: 1.5rem;
                color: #555;
                flex-shrink: 0;
            }
            .vf-cover-url-thumb img {
                width: 100%;
                height: 100%;
                object-fit: cover;
                border-radius: 3px;
            }
            .vf-cover-url-info { min-width: 0; }
            .vf-cover-url-title {
                color: #fff;
                font-weight: bold;
                font-size: 0.88rem;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .vf-cover-url-meta { color: #888; font-size: 0.75rem; margin-top: 0.2rem; }
            .vf-cover-url-input-wrap {
                display: flex;
                flex-direction: column;
                gap: 0.25rem;
                min-width: 0;
            }
            .vf-cover-url-input {
                width: 100%;
                background: #0d0d1a;
                border: 1px solid #3a3a5e;
                border-radius: 3px;
                color: #ddd;
                padding: 0.35rem 0.5rem;
                font-size: 0.8rem;
                min-width: 200px;
                box-sizing: border-box;
            }
            .vf-cover-url-input:focus { outline: none; border-color: #0066cc; }
            .vf-cover-url-status {
                font-size: 0.7rem;
                height: 1em;
                color: #888;
                white-space: nowrap;
            }
            .vf-cover-url-status.ok { color: #66bb6a; }
            .vf-cover-url-status.err { color: #ef5350; }
            .vf-cover-url-btn {
                background: #0066cc;
                color: #fff;
                border: none;
                border-radius: 4px;
                padding: 0.4rem 0.8rem;
                font-size: 0.78rem;
                cursor: pointer;
                font-weight: bold;
                white-space: nowrap;
                align-self: center;
            }
            .vf-cover-url-btn:hover { background: #0052a3; }
            .vf-cover-url-btn:disabled { opacity: 0.6; cursor: progress; }
            .vf-cover-url-empty {
                color: #666;
                text-align: center;
                padding: 2rem;
                font-size: 0.9rem;
            }
            /* Scene card badge */
            .vf-badge {
                position: absolute;
                top: 0.4rem;
                right: 0.4rem;
                background: rgba(20, 100, 180, 0.88);
                color: #fff;
                font-size: 0.7rem;
                font-weight: 700;
                border-radius: 3px;
                padding: 2px 5px;
                pointer-events: none;
                z-index: 10;
                box-shadow: 0 1px 4px rgba(0,0,0,0.5);
                letter-spacing: 0.04em;
            }
        `;
        document.head.appendChild(s);
    }


    // ── Gallery Modal ─────────────────────────────────────────────────────────
    async function buildGalleryModal(movies) {
        // Create modal container if it doesn't exist
        let modal = document.getElementById('vf-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'vf-modal';
            document.body.appendChild(modal);
        }

        modal.innerHTML = `
            <div id="vf-modal-content">
                <div class="vf-modal-header">
                    <h2>🎬 VintageFilms Gallery</h2>
                    <div class="vf-modal-header-actions">
                        <div class="vf-modal-root-controls">
                            <span class="vf-modal-root-label">Root</span>
                            <input id="vf-root-input" class="vf-modal-root-input" type="text" placeholder="${DEFAULT_VINTAGE_ROOT}" />
                            <button class="vf-modal-root-default" type="button">Default</button>
                            <button class="vf-modal-root-save" type="button">Save</button>
                            <span class="vf-modal-root-status">Loading...</span>
                        </div>
                        <button class="vf-modal-cover-urls">🖼️ Cover URLs</button>
                        <button class="vf-modal-scrape-missing">Scrape Missing Covers</button>
                        <button class="vf-modal-repair-all">Repair All</button>
                        <button class="vf-modal-close">✕ Close</button>
                    </div>
                </div>
                <div id="vf-gallery-grid"></div>
            </div>
        `;

        const rootInput = modal.querySelector('#vf-root-input');
        const rootSaveBtn = modal.querySelector('.vf-modal-root-save');
        const rootDefaultBtn = modal.querySelector('.vf-modal-root-default');
        const rootStatus = modal.querySelector('.vf-modal-root-status');

        function setRootStatus(text, isError = false) {
            rootStatus.textContent = text;
            rootStatus.style.color = isError ? '#f28b82' : '#9ea1c7';
        }

        async function saveRootPath() {
            const value = normalizeRootPath(rootInput.value);
            rootSaveBtn.disabled = true;
            setRootStatus('Saving...');
            try {
                await savePluginConfig({ vintageRoot: value });
                rootInput.value = value;
                setRootStatus('Saved');
            } catch (err) {
                console.error('[vintage-films] Failed to save vintage root', err);
                setRootStatus('Save failed', true);
            } finally {
                rootSaveBtn.disabled = false;
            }
        }

        try {
            const cfg = await loadPluginConfig();
            const loaded = normalizeRootPath(cfg?.vintageRoot || cfg?.vintage_root || '');
            rootInput.value = loaded;
            setRootStatus('Loaded');
        } catch (err) {
            console.error('[vintage-films] Failed to load vintage root setting', err);
            rootInput.value = DEFAULT_VINTAGE_ROOT;
            setRootStatus('Load failed', true);
        }

        rootSaveBtn.addEventListener('click', saveRootPath);
        rootDefaultBtn.addEventListener('click', () => {
            rootInput.value = DEFAULT_VINTAGE_ROOT;
            setRootStatus('Default set');
        });
        rootInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                saveRootPath();
            }
        });

        const grid = modal.querySelector('#vf-gallery-grid');

        function renderGrid(movieList) {
            grid.innerHTML = '';
            for (const m of movieList) {
                const card = document.createElement('div');
                card.className = 'vf-gallery-card';
                card.innerHTML = `
                    <div class="vf-gallery-card-info">
                        <div class="vf-gallery-card-title"></div>
                        <div class="vf-gallery-card-meta"></div>
                    </div>
                    <div class="vf-gallery-card-actions">
                        <button class="vf-gallery-card-btn vf-gallery-card-repair">TPDB</button>
                        <button class="vf-gallery-card-btn vf-gallery-card-upload">⬆ Upload</button>
                    </div>
                `;
                syncGalleryCard(card, m);

                card.addEventListener('click', (e) => {
                    if (!e.target.closest('button')) {
                        window.location.href = moviePlayHref(card._movie || m);
                    }
                });

                card.querySelector('.vf-gallery-card-upload').addEventListener('click', (e) => {
                    e.stopPropagation();
                    triggerCoverUpload(m.id, card);
                });

                card.querySelector('.vf-gallery-card-repair').addEventListener('click', (e) => {
                    e.stopPropagation();
                    repairMovieFromTPDB(m.id, card, e.currentTarget);
                });

                grid.appendChild(card);
            }
        }

        async function reloadGallery() {
            const refreshed = await fetchAllMovies();
            movies.splice(0, movies.length, ...refreshed);
            renderGrid(movies);
        }

        renderGrid(movies);

        modal.querySelector('.vf-modal-repair-all').addEventListener('click', async (e) => {
            e.stopPropagation();
            await repairAllVintageMetadata(e.currentTarget);
            setTimeout(() => {
                reloadGallery().catch((err) => {
                    console.error('[vintage-films] Failed to refresh gallery after repair', err);
                });
            }, 3500);
        });

        modal.querySelector('.vf-modal-scrape-missing').addEventListener('click', async (e) => {
            e.stopPropagation();
            await scrapeMissingCovers(e.currentTarget);
            setTimeout(() => {
                reloadGallery().catch((err) => {
                    console.error('[vintage-films] Failed to refresh gallery after scrape', err);
                });
            }, 3500);
        });

        // Cover URLs button opens the cover-URL editor, sharing the same movies array
        modal.querySelector('.vf-modal-cover-urls').addEventListener('click', async (e) => {
            e.stopPropagation();
            modal.classList.remove('open');
            let coverUrlModal = document.getElementById('vf-cover-url-modal');
            if (!coverUrlModal) {
                coverUrlModal = await buildCoverUrlModal(movies);
            }
            coverUrlModal._renderList();
            coverUrlModal.classList.add('open');
        });

        modal.querySelector('.vf-modal-close').addEventListener('click', () => {
            modal.classList.remove('open');
        });

        // Close on background click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('open');
        });

        return modal;
    }

    async function triggerCoverUpload(movieId, card) {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = 'image/*';
        input.style.display = 'none';

        input.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = async () => {
                const base64 = reader.result.split(',')[1];
                try {
                    await gql(M_MOVIE_UPDATE, {
                        input: { id: movieId, front_image: `data:${file.type};base64,${base64}` }
                    });
                    const img = card.querySelector('img');
                    if (img) {
                        img.src = reader.result;
                    } else {
                        const placeholder = card.querySelector('.vf-gallery-card-placeholder');
                        const preview = document.createElement('img');
                        preview.src = reader.result;
                        preview.alt = '';
                        if (placeholder) {
                            placeholder.replaceWith(preview);
                        } else {
                            card.insertAdjacentElement('afterbegin', preview);
                        }
                    }
                } catch (err) {
                    console.error('Upload failed:', err);
                }
            };
            reader.readAsDataURL(file);
        });

        document.body.appendChild(input);
        input.click();
        setTimeout(() => input.remove(), 100);
    }

    // ── Cover URL Editor ──────────────────────────────────────────────────────
    async function assignCoverFromUrl(movieId, url) {
        // Stash accepts an image URL directly in front_image; the server downloads it.
        const data = await gql(M_MOVIE_UPDATE, {
            input: { id: movieId, front_image: url.trim() },
        }, { throwOnError: true });
        if (!data?.movieUpdate?.id) {
            throw new Error('Stash did not confirm movie update');
        }
        return data.movieUpdate.id;
    }

    async function buildCoverUrlModal(moviesRef) {
        let modal = document.getElementById('vf-cover-url-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'vf-cover-url-modal';
            document.body.appendChild(modal);
        }

        modal.innerHTML = `
            <div id="vf-cover-url-modal-content">
                <div class="vf-cover-url-header">
                    <h2>🖼️ Assign Cover URLs</h2>
                    <div class="vf-cover-url-header-actions">
                        <label class="vf-cover-url-filter">
                            <input id="vf-cover-url-missing-only" type="checkbox" checked />
                            Show missing covers only
                        </label>
                        <button class="vf-cover-url-refresh">Refresh</button>
                        <button class="vf-cover-url-save-all">Save All</button>
                        <button class="vf-cover-url-close">✕ Close</button>
                    </div>
                </div>
                <div id="vf-cover-url-list"></div>
            </div>
        `;

        const list = modal.querySelector('#vf-cover-url-list');
        const missingOnlyChk = modal.querySelector('#vf-cover-url-missing-only');
        const refreshBtn = modal.querySelector('.vf-cover-url-refresh');
        const rowMap = new Map(); // movieId → { inputEl, statusEl, btnEl, movie }

        async function refreshMoviesRef() {
            const latest = await fetchAllMovies();
            moviesRef.splice(0, moviesRef.length, ...latest);
            return moviesRef;
        }

        function rowStatus(rowData, text, cls = '') {
            rowData.statusEl.textContent = text;
            rowData.statusEl.className = 'vf-cover-url-status' + (cls ? ' ' + cls : '');
        }

        async function waitForCover(movieId, attempts = 8, delayMs = 700) {
            for (let i = 0; i < attempts; i++) {
                const movie = await fetchMovie(movieId);
                if (movie?.front_image_path) return movie;
                await sleep(delayMs);
            }
            return await fetchMovie(movieId);
        }

        async function saveRow(rowData) {
            const url = rowData.inputEl.value.trim();
            if (!url) {
                rowStatus(rowData, 'Nothing to save', '');
                return;
            }
            rowData.btnEl.disabled = true;
            rowStatus(rowData, 'Saving…', '');
            try {
                await assignCoverFromUrl(rowData.movie.id, url);
                // Wait for server-side image fetch + persistence.
                const updated = await waitForCover(rowData.movie.id);
                if (updated) {
                    rowData.movie = updated;
                    updateRowThumb(rowData, updated);
                }
                if (!updated?.front_image_path) {
                    throw new Error('Cover URL was submitted, but Stash did not persist a cover image');
                }
                rowStatus(rowData, '✓ Saved', 'ok');
                rowData.inputEl.value = '';
                const row = rowData.btnEl.closest('.vf-cover-url-row');
                if (row) row.classList.toggle('has-cover', true);
            } catch (err) {
                console.error('[vintage-films] Cover URL save failed', err);
                rowStatus(rowData, `✗ ${err?.message || 'Failed'}`, 'err');
            } finally {
                rowData.btnEl.disabled = false;
            }
        }

        function updateRowThumb(rowData, movie) {
            const thumbWrap = rowData.thumbWrap;
            if (!thumbWrap) return;
            if (movie.front_image_path) {
                thumbWrap.innerHTML = `<img src="${movie.front_image_path}?${Date.now()}" alt="" />`;
            } else {
                thumbWrap.textContent = '📽️';
            }
        }

        function renderList() {
            list.innerHTML = '';
            rowMap.clear();
            const missingOnly = missingOnlyChk.checked;
            const movies = moviesRef.filter(m => !missingOnly || !m.front_image_path);

            if (!movies.length) {
                list.innerHTML = `<div class="vf-cover-url-empty">${
                    missingOnly ? '🎉 All films already have a cover!' : 'No films found.'
                }</div>`;
                return;
            }

            for (const m of movies) {
                const hasCover = !!m.front_image_path;
                const row = document.createElement('div');
                row.className = 'vf-cover-url-row' + (hasCover ? ' has-cover' : '');

                const thumbWrap = document.createElement('div');
                thumbWrap.className = 'vf-cover-url-thumb';
                if (hasCover) {
                    thumbWrap.innerHTML = `<img src="${m.front_image_path}" alt="" />`;
                } else {
                    thumbWrap.textContent = '📽️';
                }

                const info = document.createElement('div');
                info.className = 'vf-cover-url-info';
                info.innerHTML = `
                    <div class="vf-cover-url-title" title="${m.name}">${m.name}</div>
                    <div class="vf-cover-url-meta">${movieMetaText(m)}</div>
                `;

                const inputWrap = document.createElement('div');
                inputWrap.className = 'vf-cover-url-input-wrap';
                const input = document.createElement('input');
                input.type = 'text';
                input.className = 'vf-cover-url-input';
                input.placeholder = 'Paste direct image URL…';
                const status = document.createElement('div');
                status.className = 'vf-cover-url-status';
                inputWrap.appendChild(input);
                inputWrap.appendChild(status);

                const btn = document.createElement('button');
                btn.className = 'vf-cover-url-btn';
                btn.textContent = 'Save';

                row.appendChild(thumbWrap);
                row.appendChild(info);
                row.appendChild(inputWrap);
                row.appendChild(btn);
                list.appendChild(row);

                const rowData = { movie: m, inputEl: input, statusEl: status, btnEl: btn, thumbWrap };
                rowMap.set(m.id, rowData);

                btn.addEventListener('click', () => saveRow(rowData));
                input.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') { e.preventDefault(); saveRow(rowData); }
                });
            }
        }

        missingOnlyChk.addEventListener('change', renderList);

        refreshBtn.addEventListener('click', async () => {
            const original = refreshBtn.textContent;
            refreshBtn.disabled = true;
            refreshBtn.textContent = 'Refreshing…';
            try {
                await refreshMoviesRef();
                renderList();
            } catch (err) {
                console.error('[vintage-films] Failed to refresh cover URL list', err);
            } finally {
                refreshBtn.disabled = false;
                refreshBtn.textContent = original;
            }
        });

        modal.querySelector('.vf-cover-url-save-all').addEventListener('click', async (e) => {
            const btn = e.currentTarget;
            btn.disabled = true;
            btn.textContent = 'Saving…';
            const saves = [];
            for (const rowData of rowMap.values()) {
                if (rowData.inputEl.value.trim()) saves.push(saveRow(rowData));
            }
            if (saves.length) {
                await Promise.allSettled(saves);
            }
            btn.textContent = saves.length ? 'Done' : 'Nothing to save';
            setTimeout(() => { btn.disabled = false; btn.textContent = 'Save All'; }, 1500);
        });

        modal.querySelector('.vf-cover-url-close').addEventListener('click', () => {
            modal.classList.remove('open');
        });
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('open');
        });

        // Store helpers so callers can refresh state before opening.
        modal._renderList = renderList;
        modal._refreshMovies = refreshMoviesRef;

        return modal;
    }

    // ── Navbar ────────────────────────────────────────────────────────────────
    async function buildNavbar() {
        const navbar = document.querySelector('.navbar-nav');
        if (!navbar) return;
        dedupeNavbarItems();
        if (document.getElementById('vf-nav-item')) return;
        if (navbarBuildPromise) return navbarBuildPromise;

        navbarBuildPromise = (async () => {
            try {
                const movies = await fetchAllMovies();
                const liveNavbar = document.querySelector('.navbar-nav');
                if (!liveNavbar) return;
                dedupeNavbarItems();
                if (document.getElementById('vf-nav-item')) return;

                const li = document.createElement('li');
                li.id = 'vf-nav-item';
                li.className = 'nav-item';

                const toggle = document.createElement('span');
                toggle.className = 'vf-toggle nav-link';
                toggle.textContent = '🎬 VintageFilms';
                li.appendChild(toggle);

                const drop = document.createElement('div');
                drop.id = 'vf-dropdown';

                const modal = await buildGalleryModal(movies);
                const coverUrlModal = await buildCoverUrlModal(movies);

                const hdr = document.createElement('div');
                hdr.className = 'vf-dropdown-header';
                hdr.innerHTML = `<div class="vf-dropdown-header-title">${movies.length} vintage films</div>`;
                const galleryBtn = document.createElement('button');
                galleryBtn.textContent = 'Gallery';
                galleryBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    drop.classList.remove('open');
                    modal.classList.add('open');
                });
                hdr.appendChild(galleryBtn);

                const coverUrlBtn = document.createElement('button');
                coverUrlBtn.textContent = '🖼️ Cover URLs';
                coverUrlBtn.style.cssText = 'background:#5c3d8a;';
                coverUrlBtn.addEventListener('mouseenter', () => coverUrlBtn.style.background = '#4a2f72');
                coverUrlBtn.addEventListener('mouseleave', () => coverUrlBtn.style.background = '#5c3d8a');
                coverUrlBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    drop.classList.remove('open');
                    Promise.resolve(coverUrlModal._refreshMovies?.())
                        .then(() => {
                            coverUrlModal._renderList();
                            coverUrlModal.classList.add('open');
                        })
                        .catch((err) => {
                            console.error('[vintage-films] Failed to refresh cover URL modal', err);
                            coverUrlModal._renderList();
                            coverUrlModal.classList.add('open');
                        });
                });
                hdr.appendChild(coverUrlBtn);
                drop.appendChild(hdr);

                const search = document.createElement('input');
                search.id = 'vf-dropdown-search';
                search.type = 'text';
                search.placeholder = 'Filter…';
                drop.appendChild(search);

                const listWrap = document.createElement('div');
                drop.appendChild(listWrap);

                function renderList(filter) {
                    listWrap.innerHTML = '';
                    const query = filter.toLowerCase();
                    let shown = 0;
                    for (const m of movies) {
                        if (query && !m.name.toLowerCase().includes(query)) continue;
                        if (shown >= 200) break;
                        const a = document.createElement('a');
                        const year = m.date ? m.date.slice(0, 4) : '?';
                        const studio = m.studio?.name ? ` · ${m.studio.name}` : '';
                        a.href = moviePlayHref(m);
                        a.textContent = `${m.name} (${year})${studio}`;
                        a.title = a.textContent;
                        listWrap.appendChild(a);
                        shown++;
                    }
                    if (!shown) {
                        const empty = document.createElement('div');
                        empty.style.cssText = 'padding:0.4rem 0.75rem;color:#666;font-size:0.82rem;';
                        empty.textContent = 'No movies found';
                        listWrap.appendChild(empty);
                    }
                }

                renderList('');
                search.addEventListener('input', () => renderList(search.value));

                li.appendChild(drop);
                liveNavbar.appendChild(li);

                toggle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    drop.classList.toggle('open');
                    if (drop.classList.contains('open')) {
                        search.value = '';
                        renderList('');
                        setTimeout(() => search.focus(), 50);
                    }
                });
                document.addEventListener('click', () => drop.classList.remove('open'));
                drop.addEventListener('click', (e) => e.stopPropagation());
            } finally {
                navbarBuildPromise = null;
            }
        })();

        return navbarBuildPromise;
    }

    // ── Scene card badges ─────────────────────────────────────────────────────
    // Query movies for a batch of scene IDs
    async function fetchMovieStatus(sceneIds) {
        if (!sceneIds.length) return {};
        const aliases = sceneIds
            .map((id, i) => `s${i}: findScene(id: "${id}") { id movies { movie { id } } }`)
            .join('\n');
        const data = await gql(`{ ${aliases} }`);
        const result = {};
        for (const v of Object.values(data ?? {})) {
            if (v?.id) result[v.id] = (v.movies || []).length > 0;
        }
        return result;
    }

    function getSceneIdFromCard(card) {
        const a = card.querySelector('a[href*="/scenes/"]');
        if (!a) return null;
        const m = a.getAttribute('href').match(/\/scenes\/(\d+)/);
        return m ? m[1] : null;
    }

    async function applyBadges() {
        const cards = Array.from(document.querySelectorAll('.scene-card, [class*="SceneCard"]'))
                            .filter(c => !c.querySelector('.vf-badge'));
        if (!cards.length) return;

        const idMap = {};
        const ids = [];
        for (const card of cards) {
            const id = getSceneIdFromCard(card);
            if (id) { idMap[id] = card; ids.push(id); }
        }
        if (!ids.length) return;

        const status = await fetchMovieStatus(ids);
        for (const [id, hasMovie] of Object.entries(status)) {
            if (!hasMovie) continue;
            const card = idMap[id];
            if (!card) continue;
            const wrapper = card.querySelector('.thumbnail-container, .card-image, [class*="thumbnail"]') || card;
            if (getComputedStyle(wrapper).position === 'static') {
                wrapper.style.position = 'relative';
            }
            const badge = document.createElement('span');
            badge.className = 'vf-badge';
            badge.textContent = '🎬';
            badge.title = 'Part of a film';
            wrapper.appendChild(badge);
        }
    }

    // ── Initialisation ────────────────────────────────────────────────────────
    function init() {
        injectStyles();
        buildNavbar();
        applyBadges();
    }

    // React re-render observer
    const observer = new MutationObserver(() => {
        buildNavbar();
        applyBadges();
    });

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
            init();
            observer.observe(document.body, { childList: true, subtree: true });
        });
    } else {
        init();
        observer.observe(document.body, { childList: true, subtree: true });
    }

})();
