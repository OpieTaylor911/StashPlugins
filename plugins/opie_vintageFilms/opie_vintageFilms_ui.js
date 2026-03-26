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
    async function gql(query, variables) {
        const resp = await fetch(API, {
            method     : 'POST',
            headers    : { 'Content-Type': 'application/json' },
            body       : JSON.stringify({ query, variables }),
            credentials: 'include',
        });
        const payload = await resp.json();
        if (payload.errors?.length) {
            console.error('[vintage-films] GraphQL error', payload.errors);
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
