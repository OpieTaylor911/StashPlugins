/**
 * Decade Tagger — Navbar UI
 *
 * Adds a "Decades" dropdown to the Stash top navbar.
 * Queries the local GraphQL API for all Filmed-XXXX tags,
 * sorts them newest-first, and links each to its tag/scenes page.
 *
 * Works without Bootstrap JS — the dropdown is pure DOM/CSS/event.
 */
(function () {
    'use strict';

    if (window._decadeTaggerNavLoaded) return;
    window._decadeTaggerNavLoaded = true;

    const API       = window.location.origin + '/graphql';
    const DECADE_RE = /^Filmed-(\d{4})s$/;

    // ── GraphQL ──────────────────────────────────────────────────────────────
    async function gql(query) {
        const resp = await fetch(API, {
            method : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body   : JSON.stringify({ query }),
            credentials: 'include',
        });
        return (await resp.json()).data;
    }

    const Q_DECADE_TAGS = `{
      findTags(
        tag_filter: { name: { value: "Filmed-", modifier: INCLUDES } }
        filter: { per_page: 50, sort: "name" }
      ) { tags { id name } }
    }`;

    // ── Styles ───────────────────────────────────────────────────────────────
    function injectStyles() {
        if (document.getElementById('decade-nav-styles')) return;
        const s = document.createElement('style');
        s.id = 'decade-nav-styles';
        s.textContent = `
            #decade-nav-item {
                position: relative;
            }
            #decade-nav-item .decade-toggle {
                cursor: pointer;
                user-select: none;
                padding: 0.5rem 0.75rem;
                white-space: nowrap;
            }
            #decade-nav-item .decade-toggle:hover {
                opacity: 0.8;
            }
            #decade-dropdown {
                display: none;
                position: absolute;
                top: 100%;
                left: 0;
                background: #1b1b2f;
                border: 1px solid #444;
                border-radius: 5px;
                min-width: 170px;
                z-index: 10000;
                box-shadow: 0 6px 20px rgba(0,0,0,.7);
                padding: 4px 0;
            }
            #decade-dropdown.open {
                display: block;
            }
            #decade-dropdown a {
                display: block;
                padding: 7px 18px;
                color: #ccc;
                text-decoration: none;
                font-size: 0.9rem;
            }
            #decade-dropdown a:hover {
                background: #2e2e50;
                color: #fff;
            }
        `;
        document.head.appendChild(s);
    }

    // ── Build nav item ───────────────────────────────────────────────────────
    async function buildDecadeNav(navList) {
        if (navList.querySelector('#decade-nav-item')) return;

        let data;
        try { data = await gql(Q_DECADE_TAGS); } catch (e) { return; }
        if (!data) return;

        const decades = (data.findTags.tags || [])
            .filter(t => DECADE_RE.test(t.name))
            .sort((a, b) => b.name.localeCompare(a.name));  // newest first

        if (!decades.length) return;   // none created yet — skip

        injectStyles();

        // ── Wrapper <li>
        const li = document.createElement('li');
        li.id = 'decade-nav-item';
        li.className = 'nav-item';

        // ── Toggle link
        const toggle = document.createElement('a');
        toggle.className = 'nav-link decade-toggle';
        toggle.textContent = '🗓 Decades';

        // ── Dropdown panel
        const menu = document.createElement('div');
        menu.id = 'decade-dropdown';

        decades.forEach(tag => {
            const a = document.createElement('a');
            a.href = `/tags/${tag.id}/scenes`;
            a.textContent = tag.name;
            menu.appendChild(a);
        });

        // ── Toggle open/close on click
        toggle.addEventListener('click', e => {
            e.stopPropagation();
            menu.classList.toggle('open');
        });

        // ── Close when clicking anywhere else
        document.addEventListener('click', () => menu.classList.remove('open'));

        li.appendChild(toggle);
        li.appendChild(menu);
        navList.appendChild(li);
    }

    // ── Injection logic ───────────────────────────────────────────────────────
    // React may re-render the navbar on navigation, removing our node.
    // We watch with a MutationObserver and re-inject if it disappears.

    let pending = false;

    function tryInject() {
        if (pending) return;
        const navList = document.querySelector('ul.navbar-nav');
        if (!navList) return;
        if (navList.querySelector('#decade-nav-item')) return;  // already there

        pending = true;
        buildDecadeNav(navList).finally(() => { pending = false; });
    }

    const observer = new MutationObserver(() => {
        // Only act if our item is missing (avoids constant re-queries)
        if (!document.querySelector('#decade-nav-item')) {
            tryInject();
        }
    });

    function start() {
        injectStyles();
        observer.observe(document.body, { childList: true, subtree: true });
        tryInject();
    }

    if (document.body) {
        start();
    } else {
        document.addEventListener('DOMContentLoaded', start);
    }
})();
