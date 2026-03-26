(function () {
    'use strict';

    // Guard against double-initialization
    if (window.performerCircumcisedBadgeLoaded) return;
    window.performerCircumcisedBadgeLoaded = true;

    const { stash, waitForElementClass } = window.stash7dJx1qP;

    // ── Styles ──────────────────────────────────────────────────────────────
    document.head.appendChild(Object.assign(document.createElement('style'), {
        textContent: `
.circ-badge {
    position: absolute;
    bottom: 0.5rem;
    left: 0.5rem;
    padding: 2px 7px;
    border-radius: 4px;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: #fff;
    pointer-events: none;
    z-index: 10;
    box-shadow: 0 1px 4px rgba(0,0,0,0.6);
    user-select: none;
}
.circ-badge.circ-cut {
    background: rgba(192, 57, 43, 0.90);
}
.circ-badge.circ-uncut {
    background: rgba(22, 115, 90, 0.90);
}
.circ-badge.circ-variable {
    background: rgba(80, 80, 110, 0.90);
}
`
    }));

    // ── GraphQL helpers ─────────────────────────────────────────────────────
    const apiKey = localStorage.getItem('apiKey') || null;

    async function fetchCircumcised(ids) {
        if (!ids.length) return {};
        // Batch all lookups in a single request using query aliases
        const aliases = ids
            .map((id, i) => `p${i}: findPerformer(id: "${id}") { id circumcised }`)
            .join('\n');
        const query = `{ ${aliases} }`;

        let data;
        try {
            const resp = await fetch('/graphql', {
                method: 'POST',
                headers: Object.assign(
                    { 'Content-Type': 'application/json' },
                    apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}
                ),
                body: JSON.stringify({ query }),
            });
            ({ data } = await resp.json());
        } catch (e) {
            console.error('[circ-badge] GQL error', e);
            return {};
        }

        const result = {};
        for (const val of Object.values(data ?? {})) {
            if (val?.id) result[val.id] = val.circumcised; // null if unset
        }
        return result;
    }

    // ── Badge injection ──────────────────────────────────────────────────────
    function badgeClass(status) {
        if (status === 'CUT')      return 'circ-cut';
        if (status === 'UNCUT')    return 'circ-uncut';
        if (status === 'VARIABLE') return 'circ-variable';
        return null;
    }

    function badgeLabel(status) {
        if (status === 'CUT')      return '✂ Cut';
        if (status === 'UNCUT')    return '○ Uncut';
        if (status === 'VARIABLE') return '~ Var';
        return null;
    }

    async function processCards() {
        // Only process cards that haven't been handled yet
        const cards = [...document.querySelectorAll('.performer-card:not([data-circ])')];
        if (!cards.length) return;

        // Gather IDs while marking cards as being processed
        const idToCard = {};
        for (const card of cards) {
            card.dataset.circ = 'pending';
            const link = card.querySelector('.thumbnail-section > a');
            const id = link?.href.match(/\/performers\/(\d+)/)?.[1];
            if (id) idToCard[id] = card;
        }

        const circMap = await fetchCircumcised(Object.keys(idToCard));

        for (const [id, card] of Object.entries(idToCard)) {
            card.dataset.circ = 'done';
            const status = circMap[id];
            if (!status) continue; // null / not set — show nothing

            const cls   = badgeClass(status);
            const label = badgeLabel(status);
            if (!cls) continue;

            // Remove any stale badge (e.g. card reused by React)
            card.querySelector('.circ-badge')?.remove();

            const badge = document.createElement('span');
            badge.className = `circ-badge ${cls}`;
            badge.textContent = label;

            const thumb = card.querySelector('.thumbnail-section');
            if (thumb) thumb.appendChild(badge);
        }
    }

    // Reset data-circ markers when the page changes so cards get re-evaluated
    function resetAndProcess() {
        document.querySelectorAll('[data-circ]').forEach(el => el.removeAttribute('data-circ'));
        waitForElementClass('performer-card', processCards);
    }

    // ── Page event hooks ─────────────────────────────────────────────────────
    const PAGES = [
        'page:performers',
        'page:performer:scenes',
        'page:performer:galleries',
        'page:performer:appearswith',
        'page:studio:performers',
        'page:tag:performers',
        'page:scene',
        'page:group',
    ];

    for (const ev of PAGES) {
        stash.addEventListener(ev, resetAndProcess);
    }

})();
