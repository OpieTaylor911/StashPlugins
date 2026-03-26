(function () {
    'use strict';

    if (window.circumManagerLoaded) return;
    window.circumManagerLoaded = true;

    const { stash } = window.stash7dJx1qP;

    // ── State ────────────────────────────────────────────────────────────────
    let allPerformers = [];
    let pendingChanges = {}; // { [id]: 'CUT' | 'UNCUT' | null }
    let activeFilter  = 'all';
    let searchText    = '';
    let isSaving      = false;

    // ── GraphQL ──────────────────────────────────────────────────────────────
    const apiKey = localStorage.getItem('apiKey') || '';

    async function gql(query, variables = {}) {
        const resp = await fetch('/graphql', {
            method: 'POST',
            headers: Object.assign(
                { 'Content-Type': 'application/json' },
                apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}
            ),
            body: JSON.stringify({ query, variables }),
        });
        const json = await resp.json();
        if (json.errors?.length) throw new Error(json.errors[0].message);
        return json.data;
    }

    async function loadAllPerformers(onProgress) {
        let result = [];
        let page = 1;
        while (true) {
            const data = await gql(`
                query ($page: Int!) {
                    findPerformers(filter: { page: $page, per_page: 100, sort: "name" }) {
                        count
                        performers { id name image_path circumcised }
                    }
                }
            `, { page });
            result = result.concat(data.findPerformers.performers);
            onProgress?.(result.length, data.findPerformers.count);
            if (result.length >= data.findPerformers.count) break;
            page++;
        }
        return result;
    }

    async function updatePerformer(id, circumcised) {
        return gql(`
            mutation ($id: ID!, $circumcised: CircumisedEnum) {
                performerUpdate(input: { id: $id, circumcised: $circumcised }) {
                    id circumcised
                }
            }
        `, { id, circumcised });
    }

    // ── Utilities ────────────────────────────────────────────────────────────
    function esc(str) {
        return String(str ?? '').replace(/[&<>"']/g, c =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
        );
    }

    // image_path comes back as http://localhost:9999/... — strip the origin so
    // the browser hits the actual host the page is served from.
    function relImgUrl(rawPath) {
        if (!rawPath) return '';
        try {
            const u = new URL(rawPath);
            return u.pathname + u.search;
        } catch (_) {
            return rawPath;
        }
    }

    function currentStatus(p) {
        return pendingChanges.hasOwnProperty(p.id)
            ? pendingChanges[p.id]
            : (p.circumcised ?? null);
    }

    function filteredPerformers() {
        return allPerformers.filter(p => {
            if (searchText && !p.name.toLowerCase().includes(searchText.toLowerCase()))
                return false;
            const s = currentStatus(p);
            switch (activeFilter) {
                case 'CUT':     return s === 'CUT';
                case 'UNCUT':   return s === 'UNCUT';
                case 'NONE':    return s === null;
                case 'changed': return pendingChanges.hasOwnProperty(p.id);
                default:        return true;
            }
        });
    }

    // ── CSS ──────────────────────────────────────────────────────────────────
    function injectCSS() {
        if (document.getElementById('circ-mgr-css')) return;
        document.head.appendChild(Object.assign(document.createElement('style'), {
            id: 'circ-mgr-css',
            textContent: `
#circ-fab {
    position: fixed; bottom: 1.8rem; right: 1.8rem; z-index: 900;
    background: #9b2335; color: #fff; border: none; border-radius: 50px;
    padding: 10px 20px; font-size: 13px; font-weight: 700; cursor: pointer;
    box-shadow: 0 4px 14px rgba(0,0,0,0.55); letter-spacing: .04em;
    transition: background .15s;
}
#circ-fab:hover { background: #7b1b28; }

#circ-modal {
    position: fixed; inset: 0; z-index: 1050;
    display: flex; flex-direction: column;
    background: #171923; color: #e2e8f0; font-family: inherit;
}

#circ-topbar {
    display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
    padding: 10px 16px; background: #1a202c;
    border-bottom: 1px solid #2d3748; flex-shrink: 0;
}
#circ-topbar h2 { margin: 0; font-size: 1rem; font-weight: 700; white-space: nowrap; }

#circ-search {
    flex: 1; min-width: 140px; max-width: 260px;
    background: #2d3748; border: 1px solid #4a5568; border-radius: 6px;
    color: #e2e8f0; padding: 6px 12px; font-size: 13px; outline: none;
}
#circ-search:focus { border-color: #718096; }

.circ-pills { display: flex; gap: 5px; flex-wrap: wrap; }
.circ-pill {
    background: #2d3748; border: 1px solid #4a5568; border-radius: 20px;
    color: #a0aec0; padding: 4px 12px; font-size: 11px; font-weight: 700;
    cursor: pointer; white-space: nowrap; text-transform: uppercase;
    letter-spacing: .05em; transition: all .12s;
}
.circ-pill:hover { background: #3a4a5a; color: #e2e8f0; }
.circ-pill.active                       { background: #4a5568; color: #fff; border-color: #718096; }
.circ-pill[data-filter="CUT"].active    { background: #9b2335; border-color: #c53030; }
.circ-pill[data-filter="UNCUT"].active  { background: #276749; border-color: #38a169; }
.circ-pill[data-filter="changed"].active{ background: #7b4f12; border-color: #d69e2e; }
.circ-pill[data-filter="NONE"].active   { background: #2d3748; color: #a0aec0; border-color: #718096; }

#circ-close {
    margin-left: auto; background: none; border: 1px solid #4a5568;
    color: #a0aec0; border-radius: 6px; padding: 5px 14px;
    cursor: pointer; font-size: 13px; white-space: nowrap;
}
#circ-close:hover { color: #fff; border-color: #718096; }

#circ-body { flex: 1; overflow-y: auto; padding: 16px; }

#circ-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(162px, 1fr));
    gap: 14px;
}

.cp-card {
    background: #1a202c; border-radius: 8px; overflow: hidden;
    border: 2px solid transparent; transition: border-color .15s, box-shadow .15s;
}
.cp-card:hover   { box-shadow: 0 4px 18px rgba(0,0,0,0.5); }
.cp-card.changed { border-color: #d69e2e; }

.cp-img-wrap {
    position: relative; width: 100%; padding-bottom: 133%;
    overflow: hidden; background: #2d3748;
}
.cp-img-wrap img {
    position: absolute; inset: 0; width: 100%; height: 100%;
    object-fit: cover; object-position: top center;
}

.cp-chip {
    position: absolute; bottom: 6px; right: 6px;
    padding: 2px 7px; border-radius: 4px;
    font-size: 10px; font-weight: 800; text-transform: uppercase;
    letter-spacing: .07em; color: #fff; pointer-events: none;
}
.cp-chip-CUT      { background: rgba(155,35,53,.92); }
.cp-chip-UNCUT    { background: rgba(39,103,73,.92); }
.cp-chip-VARIABLE { background: rgba(80,55,140,.92); }
.cp-chip-pending  { background: rgba(180,120,10,.92); }

.cp-info { padding: 8px 9px 10px; }
.cp-name {
    font-size: 11px; font-weight: 700; color: #e2e8f0;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    margin-bottom: 8px;
}
.cp-btns { display: flex; flex-direction: column; gap: 3px; }
.cp-btn {
    display: flex; align-items: center; gap: 7px;
    padding: 5px 8px; border-radius: 5px; border: 1px solid transparent;
    cursor: pointer; font-size: 11px; font-weight: 700;
    color: #718096; background: #2d3748; width: 100%;
    text-align: left; transition: all .1s;
}
.cp-btn:hover          { background: #3a4a5a; color: #e2e8f0; }
.cp-btn.active-CUT     { background: #9b2335; color: #fff; border-color: #c53030; }
.cp-btn.active-UNCUT   { background: #276749; color: #fff; border-color: #38a169; }
.cp-btn.active-null    { background: #4a5568; color: #e2e8f0; border-color: #718096; }

#circ-footer {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px; background: #1a202c;
    border-top: 1px solid #2d3748; flex-shrink: 0; gap: 12px;
}
#circ-footer-info { font-size: 12px; color: #718096; }
#circ-save {
    background: #276749; color: #fff; border: none; border-radius: 6px;
    padding: 8px 22px; font-size: 13px; font-weight: 700;
    cursor: pointer; transition: background .15s; white-space: nowrap;
}
#circ-save:not(:disabled):hover { background: #38a169; }
#circ-save:disabled { background: #2d3748; color: #4a5568; cursor: default; }

#circ-loading {
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    height: 220px; color: #718096; gap: 10px; font-size: 14px;
}
#circ-load-bar-wrap {
    width: 240px; background: #2d3748; border-radius: 4px; height: 6px; overflow: hidden;
}
#circ-load-bar { height: 100%; background: #9b2335; transition: width .2s; width: 0%; }
            `
        }));
    }

    // ── Render ───────────────────────────────────────────────────────────────
    function renderGrid() {
        const grid = document.getElementById('circ-grid');
        if (!grid) return;
        const list = filteredPerformers();
        grid.innerHTML = '';
        for (const p of list) {
            grid.appendChild(buildCard(p));
        }
        updateFooter(list.length);
    }

    function buildCard(p) {
        const status   = currentStatus(p);
        const isDirty  = pendingChanges.hasOwnProperty(p.id);
        const imgUrl   = relImgUrl(p.image_path);

        const card = document.createElement('div');
        card.className = `cp-card${isDirty ? ' changed' : ''}`;
        card.dataset.id = p.id;

        const chip = chipHtml(status, isDirty);

        card.innerHTML = `
            <div class="cp-img-wrap">
                <img src="${esc(imgUrl)}" alt="${esc(p.name)}" loading="lazy"
                     onerror="this.style.opacity='0'">
                ${chip}
            </div>
            <div class="cp-info">
                <div class="cp-name" title="${esc(p.name)}">${esc(p.name)}</div>
                <div class="cp-btns">
                    ${cpBtn(p.id, 'CUT',  status, '✂ Cut')}
                    ${cpBtn(p.id, 'UNCUT',status, '○ Uncut')}
                    ${cpBtn(p.id, null,   status, '— Not Set')}
                </div>
            </div>
        `;
        return card;
    }

    function chipHtml(status, isDirty) {
        if (isDirty) {
            const label = status === 'CUT' ? '✂ Cut ●' : status === 'UNCUT' ? '○ Uncut ●' : '— None ●';
            return `<span class="cp-chip cp-chip-pending">${esc(label)}</span>`;
        }
        if (!status) return '';
        const labels = { CUT: '✂ Cut', UNCUT: '○ Uncut', VARIABLE: '~ Variable' };
        return `<span class="cp-chip cp-chip-${esc(status)}">${esc(labels[status] ?? status)}</span>`;
    }

    function cpBtn(id, value, currentSt, label) {
        const isActive = value === currentSt || (!value && !currentSt);
        const cls = isActive ? ` active-${value ?? 'null'}` : '';
        const valAttr = value ?? '';
        return `<button class="cp-btn${cls}" data-id="${id}" data-val="${valAttr}">${label}</button>`;
    }

    function updateCard(id) {
        const modal = document.getElementById('circ-modal');
        const card  = modal?.querySelector(`.cp-card[data-id="${id}"]`);
        if (!card) return;
        const p = allPerformers.find(x => x.id === id);
        if (!p) return;

        const status  = currentStatus(p);
        const isDirty = pendingChanges.hasOwnProperty(id);

        card.classList.toggle('changed', isDirty);

        // chip
        const wrap = card.querySelector('.cp-img-wrap');
        wrap.querySelector('.cp-chip')?.remove();
        const ch = chipHtml(status, isDirty);
        if (ch) wrap.insertAdjacentHTML('beforeend', ch);

        // buttons
        card.querySelectorAll('.cp-btn').forEach(btn => {
            const bval = btn.dataset.val || null;
            btn.className = 'cp-btn';
            const isActive = bval === status || (!bval && !status);
            if (isActive) btn.classList.add(`active-${bval ?? 'null'}`);
        });
    }

    function updateFooter(shownCount) {
        const info = document.getElementById('circ-footer-info');
        const btn  = document.getElementById('circ-save');
        if (!info || !btn) return;
        const changeCount = Object.keys(pendingChanges).length;
        const shown = shownCount ?? filteredPerformers().length;
        if (isSaving) {
            info.textContent = 'Saving…';
            btn.disabled = true;
            btn.textContent = 'Saving…';
        } else {
            info.textContent = `${shown} of ${allPerformers.length} performers · ${changeCount} pending`;
            btn.disabled = changeCount === 0;
            btn.textContent = changeCount
                ? `Save ${changeCount} Change${changeCount !== 1 ? 's' : ''}`
                : 'No Changes';
        }
    }

    // ── Modal ────────────────────────────────────────────────────────────────
    function buildModal() {
        const modal = document.createElement('div');
        modal.id = 'circ-modal';
        modal.innerHTML = `
            <div id="circ-topbar">
                <h2>✂ Cut / Uncut Manager</h2>
                <input id="circ-search" type="text" placeholder="Search performers…" autocomplete="off" />
                <div class="circ-pills">
                    <button class="circ-pill active" data-filter="all">All</button>
                    <button class="circ-pill" data-filter="CUT">Cut</button>
                    <button class="circ-pill" data-filter="UNCUT">Uncut</button>
                    <button class="circ-pill" data-filter="NONE">Not Set</button>
                    <button class="circ-pill" data-filter="changed">Changed</button>
                </div>
                <button id="circ-close">✕ Close</button>
            </div>
            <div id="circ-body">
                <div id="circ-loading">
                    <div>Loading performers…</div>
                    <div id="circ-load-bar-wrap"><div id="circ-load-bar"></div></div>
                    <div id="circ-load-count"></div>
                </div>
                <div id="circ-grid" style="display:none"></div>
            </div>
            <div id="circ-footer">
                <div id="circ-footer-info">Loading…</div>
                <button id="circ-save" disabled>No Changes</button>
            </div>
        `;
        return modal;
    }

    function attachEvents(modal) {
        modal.querySelector('#circ-close').addEventListener('click', closeModal);
        document.addEventListener('keydown', onEsc);

        modal.querySelector('#circ-search').addEventListener('input', e => {
            searchText = e.target.value;
            renderGrid();
        });

        modal.querySelector('.circ-pills').addEventListener('click', e => {
            const pill = e.target.closest('.circ-pill');
            if (!pill) return;
            modal.querySelectorAll('.circ-pill').forEach(p => p.classList.remove('active'));
            pill.classList.add('active');
            activeFilter = pill.dataset.filter;
            renderGrid();
        });

        modal.querySelector('#circ-grid').addEventListener('click', e => {
            const btn = e.target.closest('.cp-btn');
            if (!btn || isSaving) return;
            const id  = btn.dataset.id;
            const val = btn.dataset.val || null;
            const original = allPerformers.find(p => p.id === id)?.circumcised ?? null;
            // If same as original, clear the pending change; otherwise record it
            if (val === original || (!val && !original)) {
                delete pendingChanges[id];
            } else {
                pendingChanges[id] = val;
            }
            updateCard(id);
            updateFooter();
        });

        modal.querySelector('#circ-save').addEventListener('click', doSave);
    }

    async function doSave() {
        const ids = Object.keys(pendingChanges);
        if (!ids.length || isSaving) return;
        isSaving = true;
        updateFooter();

        let saved = 0;
        for (const id of ids) {
            try {
                await updatePerformer(id, pendingChanges[id]);
                const p = allPerformers.find(x => x.id === id);
                if (p) p.circumcised = pendingChanges[id];
                delete pendingChanges[id];
                updateCard(id);
                saved++;
                const info = document.getElementById('circ-footer-info');
                if (info) info.textContent = `Saving… ${saved} / ${ids.length}`;
            } catch (err) {
                console.error('[circ-mgr] save failed for', id, err);
            }
        }

        isSaving = false;
        updateFooter();
    }

    function onEsc(e) { if (e.key === 'Escape') closeModal(); }
    function closeModal() {
        document.getElementById('circ-modal')?.remove();
        document.removeEventListener('keydown', onEsc);
    }

    async function openModal() {
        if (document.getElementById('circ-modal')) return;
        pendingChanges = {};
        activeFilter   = 'all';
        searchText     = '';

        const modal = buildModal();
        document.body.appendChild(modal);
        attachEvents(modal);

        if (allPerformers.length === 0) {
            try {
                allPerformers = await loadAllPerformers((loaded, total) => {
                    const bar   = document.getElementById('circ-load-bar');
                    const count = document.getElementById('circ-load-count');
                    if (bar)   bar.style.width = `${Math.round((loaded / total) * 100)}%`;
                    if (count) count.textContent = `${loaded} / ${total}`;
                });
            } catch (err) {
                const el = document.getElementById('circ-loading');
                if (el) el.innerHTML = `<div style="color:#fc8181">Error: ${esc(err.message)}</div>`;
                return;
            }
        }

        document.getElementById('circ-loading').style.display = 'none';
        const grid = document.getElementById('circ-grid');
        grid.style.display = 'grid';
        renderGrid();
    }

    // ── FAB ──────────────────────────────────────────────────────────────────
    function injectFAB() {
        if (document.getElementById('circ-fab')) return;
        const fab = document.createElement('button');
        fab.id = 'circ-fab';
        fab.textContent = '✂ Cut/Uncut Manager';
        fab.addEventListener('click', openModal);
        document.body.appendChild(fab);
    }

    function removeFAB() {
        document.getElementById('circ-fab')?.remove();
        // Also close the modal if it's open when navigating away
        closeModal();
    }

    // ── Hooks ────────────────────────────────────────────────────────────────
    // Show FAB only on the main performers list page
    stash.addEventListener('page:performers', injectFAB);

    // Remove FAB when navigating to any other page
    const OTHER_PAGES = [
        'page:scene', 'page:scenes',
        'page:performer', 'page:performer:scenes', 'page:performer:galleries',
        'page:performer:appearswith',
        'page:studio', 'page:studios', 'page:studio:performers',
        'page:tag', 'page:tags', 'page:tag:performers',
        'page:group', 'page:groups',
        'page:gallery', 'page:galleries',
        'page:image', 'page:images',
        'page:settings',
    ];
    for (const ev of OTHER_PAGES) stash.addEventListener(ev, removeFAB);

    injectCSS();
})();
