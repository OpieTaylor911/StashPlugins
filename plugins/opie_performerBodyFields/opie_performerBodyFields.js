/**
 * Performer Body Fields Plugin
 * Adds Body Type, Body Influence, Position, Persona, Ethnicity, and Orientation
 * fields to the performers list page using Stash's custom_fields API.
 *
 * Compatible with Stash v0.27.0+
 */
(function () {
  'use strict';

  // ─── Field Definitions ───────────────────────────────────────────────────

  const FIELDS = [
    {
      key: 'body_type',
      label: 'Body Type',
      options: ['', 'Lean', 'Shredded', 'Stocky', 'Hairy', 'Smooth', 'Big / Thick', 'Defined abs'],
    },
    {
      key: 'body_influence',
      label: 'Body Influence',
      options: ['', 'Twink', 'Jock', 'Muscle', 'Bear', 'Otter', 'Cub', 'Chub', 'Beefy', 'Thick', 'Dad bod'],
    },
    {
      key: 'position',
      label: 'Position',
      options: ['', 'Top', 'Bottom', 'Versatile'],
    },
    {
      key: 'persona',
      label: 'Persona',
      options: [
        '', 'Jock', 'Frat', 'Bro', 'Trade (blue-collar)', 'Alpha', 'Dom', 'Sub',
        'Daddy', 'Nerd / Geek', 'Boy-next-door', 'Alternative (tattoos, edgy)',
      ],
    },
    {
      key: 'ethnicity',
      label: 'Ethnicity',
      options: ['', 'White', 'Black', 'Latino', 'Asian', 'Middle Eastern', 'Indian', 'Native', 'Islander', 'Mixed'],
    },
    {
      key: 'orientation',
      label: 'Orientation',
      options: ['', 'Bi', 'Gay', 'Straight', 'Unknown'],
    },
  ];

  // Map for quick lookup
  const FIELD_KEYS = FIELDS.map(f => f.key);

  // ─── State ────────────────────────────────────────────────────────────────

  // performer id → { name, custom_fields, ... }
  const performerCache = {};
  let currentTableContainer = null;
  let observerActive = false;

  // ─── GraphQL Helpers ─────────────────────────────────────────────────────

  async function gqlQuery(query, variables = {}) {
    const resp = await fetch('/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    return resp.json();
  }

  async function findPerformers(filter) {
    const query = `
      query FindPerformers($filter: FindFilterType, $performer_filter: PerformerFilterType) {
        findPerformers(filter: $filter, performer_filter: $performer_filter) {
          count
          performers {
            id
            name
            image_path
            favorite
            gender
            custom_fields
          }
        }
      }
    `;
    const data = await gqlQuery(query, filter);
    return data?.data?.findPerformers;
  }

  async function updatePerformerCustomField(performerId, key, value) {
    const mutation = `
      mutation PerformerUpdate($input: PerformerUpdateInput!) {
        performerUpdate(input: $input) {
          id
          custom_fields
        }
      }
    `;
    let input;
    if (value === '' || value === null || value === undefined) {
      input = { id: String(performerId), custom_fields: { remove: [key] } };
    } else {
      input = { id: String(performerId), custom_fields: { partial: { [key]: value } } };
    }
    const data = await gqlQuery(mutation, { input });
    return data?.data?.performerUpdate;
  }

  // ─── URL Parsing ─────────────────────────────────────────────────────────

  function getPerformersPageParams() {
    const params = new URLSearchParams(window.location.search);
    return {
      page: parseInt(params.get('page') || '1'),
      per_page: parseInt(params.get('per_page') || '40'),
      sort: params.get('sortby') || 'name',
      direction: (params.get('sortdir') || 'asc').toUpperCase(),
      q: params.get('q') || '',
    };
  }

  // ─── UI Building ─────────────────────────────────────────────────────────

  function buildTable(performers) {
    const table = document.createElement('table');
    table.className = 'pbf-table';

    // Header
    const thead = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const nameHeader = document.createElement('th');
    nameHeader.textContent = 'Performer';
    nameHeader.className = 'pbf-th-name';
    headerRow.appendChild(nameHeader);

    for (const field of FIELDS) {
      const th = document.createElement('th');
      th.textContent = field.label;
      headerRow.appendChild(th);
    }

    thead.appendChild(headerRow);
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    for (const performer of performers) {
      tbody.appendChild(buildRow(performer));
    }
    table.appendChild(tbody);

    return table;
  }

  function buildRow(performer) {
    const tr = document.createElement('tr');
    tr.dataset.performerId = performer.id;

    // Name cell with link and optional image
    const nameTd = document.createElement('td');
    nameTd.className = 'pbf-td-name';

    const nameInner = document.createElement('div');
    nameInner.className = 'pbf-td-name-inner';

    const link = document.createElement('a');
    link.href = `/performers/${performer.id}`;
    link.textContent = performer.name;
    link.target = '_blank';

    if (performer.image_path) {
      const img = document.createElement('img');
      img.src = performer.image_path;
      img.alt = performer.name;
      img.className = 'pbf-performer-img';
      img.onerror = () => { img.style.display = 'none'; };
      nameInner.appendChild(img);
    }

    nameInner.appendChild(link);
    nameTd.appendChild(nameInner);
    tr.appendChild(nameTd);

    const customFields = performer.custom_fields || {};

    for (const field of FIELDS) {
      const td = document.createElement('td');
      const currentValue = customFields[field.key] || '';
      const select = buildSelect(field, currentValue, performer.id);
      td.appendChild(select);
      tr.appendChild(td);
    }

    return tr;
  }

  function buildSelect(field, currentValue, performerId) {
    const select = document.createElement('select');
    select.className = 'pbf-select';
    select.dataset.fieldKey = field.key;
    select.dataset.performerId = String(performerId);

    for (const opt of field.options) {
      const option = document.createElement('option');
      option.value = opt;
      option.textContent = opt === '' ? '— none —' : opt;
      if (opt === currentValue) option.selected = true;
      select.appendChild(option);
    }

    select.addEventListener('change', handleSelectChange);
    return select;
  }

  async function handleSelectChange(event) {
    const select = event.target;
    const performerId = select.dataset.performerId;
    const fieldKey = select.dataset.fieldKey;
    const value = select.value;

    select.disabled = true;
    select.classList.add('pbf-saving');

    try {
      const result = await updatePerformerCustomField(performerId, fieldKey, value);
      if (result) {
        // Update cache
        if (performerCache[performerId]) {
          performerCache[performerId].custom_fields = result.custom_fields;
        }
        select.classList.remove('pbf-saving');
        select.classList.add('pbf-saved');
        setTimeout(() => select.classList.remove('pbf-saved'), 1500);
      } else {
        throw new Error('Mutation returned no data');
      }
    } catch (err) {
      console.error('[performerBodyFields] Failed to save:', err);
      select.classList.remove('pbf-saving');
      select.classList.add('pbf-error');
      setTimeout(() => select.classList.remove('pbf-error'), 2000);
    } finally {
      select.disabled = false;
    }
  }

  // ─── Main Panel ───────────────────────────────────────────────────────────

  function getOrCreatePanel() {
    let panel = document.getElementById('pbf-panel');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'pbf-panel';

      const header = document.createElement('div');
      header.className = 'pbf-header';

      const title = document.createElement('span');
      title.textContent = 'Body Fields';
      title.className = 'pbf-title';
      header.appendChild(title);

      const toggleBtn = document.createElement('button');
      toggleBtn.className = 'pbf-toggle-btn btn btn-sm btn-secondary';
      toggleBtn.textContent = 'Hide';
      toggleBtn.addEventListener('click', () => {
        const content = document.getElementById('pbf-content');
        if (content.style.display === 'none') {
          content.style.display = '';
          toggleBtn.textContent = 'Hide';
        } else {
          content.style.display = 'none';
          toggleBtn.textContent = 'Show';
        }
      });
      header.appendChild(toggleBtn);

      panel.appendChild(header);

      const content = document.createElement('div');
      content.id = 'pbf-content';
      panel.appendChild(content);
    }
    return panel;
  }

  async function renderBodyFieldsPanel() {
    const params = getPerformersPageParams();

    const filterVars = {
      filter: {
        page: params.page,
        per_page: params.per_page,
        sort: params.sort,
        direction: params.direction,
        q: params.q || undefined,
      },
    };

    let result;
    try {
      result = await findPerformers(filterVars);
    } catch (err) {
      console.error('[performerBodyFields] Failed to load performers:', err);
      return;
    }

    if (!result) return;

    const performers = result.performers || [];

    // Update cache
    for (const p of performers) {
      performerCache[p.id] = p;
    }

    const panel = getOrCreatePanel();
    const content = document.getElementById('pbf-content');
    content.innerHTML = '';

    if (performers.length === 0) {
      content.textContent = 'No performers found.';
    } else {
      const info = document.createElement('div');
      info.className = 'pbf-info';
      info.textContent = `Showing ${performers.length} of ${result.count} performers`;
      content.appendChild(info);

      const tableWrapper = document.createElement('div');
      tableWrapper.className = 'pbf-table-wrapper';
      tableWrapper.appendChild(buildTable(performers));
      content.appendChild(tableWrapper);
    }

    // Inject panel into the page
    injectPanel(panel);
  }

  function injectPanel(panel) {
    // If already in DOM, skip
    if (document.getElementById('pbf-panel')) return;

    // Try to find the main content area after the page toolbar/filters
    // Stash renders its pages inside .main.container-fluid > div
    // We want to inject before the grid, after the toolbar
    const targets = [
      '.main.container-fluid',
      '.container-fluid',
      'main',
      '#root',
    ];

    for (const selector of targets) {
      const el = document.querySelector(selector);
      if (el) {
        el.appendChild(panel);
        return;
      }
    }

    document.body.appendChild(panel);
  }

  // ─── Performer Detail Page ────────────────────────────────────────────────

  function getPerformerIdFromUrl() {
    const m = window.location.pathname.match(/^\/performers\/(\d+)/);
    return m ? m[1] : null;
  }

  async function fetchPerformerCustomFields(performerId) {
    const query = `
      query FindPerformer($id: ID!) {
        findPerformer(id: $id) {
          id
          name
          custom_fields
        }
      }
    `;
    const data = await gqlQuery(query, { id: String(performerId) });
    return data?.data?.findPerformer;
  }

  function buildDetailPanel(performer, isEditMode) {
    const panel = document.createElement('div');
    panel.id = 'pbf-detail-panel';
    panel.className = 'pbf-detail-panel detail-group';

    const title = document.createElement('h6');
    title.className = 'pbf-detail-title';
    title.textContent = 'Body & Profile';
    panel.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'pbf-detail-grid';

    const customFields = performer.custom_fields || {};

    for (const field of FIELDS) {
      const item = document.createElement('div');
      item.className = 'pbf-detail-item detail-item';

      const label = document.createElement('span');
      label.className = 'detail-item-title pbf-detail-label';
      label.textContent = field.label + ':';
      item.appendChild(label);

      const currentValue = customFields[field.key] || '';

      if (isEditMode) {
        // Edit mode: show dropdown
        const select = buildSelect(field, currentValue, performer.id);
        select.className += ' pbf-detail-select';
        item.appendChild(select);
      } else {
        // View mode: show read-only text matching Stash's detail-item-value style
        const valueSpan = document.createElement('span');
        valueSpan.className = 'detail-item-value pbf-detail-value';
        valueSpan.textContent = currentValue || '—';
        if (!currentValue) valueSpan.classList.add('pbf-detail-empty');
        item.appendChild(valueSpan);
      }

      grid.appendChild(item);
    }

    panel.appendChild(grid);
    return panel;
  }

  async function renderDetailPanel(isEditMode) {
    const performerId = getPerformerIdFromUrl();
    if (!performerId) return;

    document.getElementById('pbf-detail-panel')?.remove();

    const performer = await fetchPerformerCustomFields(performerId);
    if (!performer) return;

    performerCache[performerId] = Object.assign(performerCache[performerId] || {}, performer);

    const panel = buildDetailPanel(performer, isEditMode);
    injectDetailPanel(panel);
  }

  function injectDetailPanel(panel) {
    const selectors = [
      '.performer-head',
      '.detail-header .col-9',
      '.detail-header .col-xl-9',
      '.detail-header [class*="col-"]',
      '.detail-header',
    ];

    for (const sel of selectors) {
      const container = document.querySelector(sel);
      if (container) {
        const existingGroups = container.querySelectorAll('.detail-group');
        if (existingGroups.length > 0) {
          const last = existingGroups[existingGroups.length - 1];
          last.parentNode.insertBefore(panel, last.nextSibling);
        } else {
          container.appendChild(panel);
        }
        return;
      }
    }

    document.body.appendChild(panel);
  }

  // MutationObserver that watches .detail-header for the 'edit' class toggle
  let detailHeaderObserver = null;

  function attachDetailHeaderObserver() {
    if (detailHeaderObserver) {
      detailHeaderObserver.disconnect();
      detailHeaderObserver = null;
    }

    const header = document.querySelector('.detail-header');
    if (!header) return;

    let lastWasEdit = header.classList.contains('edit');

    detailHeaderObserver = new MutationObserver(() => {
      const isEdit = header.classList.contains('edit');
      if (isEdit === lastWasEdit) return;
      lastWasEdit = isEdit;
      // Re-render panel in the correct mode
      renderDetailPanel(isEdit);
    });

    detailHeaderObserver.observe(header, { attributes: true, attributeFilter: ['class'] });
  }

  // Poll for the page to render, then inject view-mode panel and attach observer
  function waitForDetailAndRender() {
    document.getElementById('pbf-detail-panel')?.remove();

    if (detailHeaderObserver) {
      detailHeaderObserver.disconnect();
      detailHeaderObserver = null;
    }

    let attempts = 0;
    const poll = setInterval(() => {
      attempts++;
      const detailGroup = document.querySelector('.detail-group');
      if (detailGroup) {
        clearInterval(poll);
        // Always start in view mode — the MutationObserver handles edit switching
        renderDetailPanel(false).then(() => attachDetailHeaderObserver());
      } else if (attempts > 40) {
        clearInterval(poll);
      }
    }, 150);
  }

  // ─── Page Navigation Detection ───────────────────────────────────────────

  let lastUrl = '';
  let debounceTimer = null;

  function onPerformersPage() {
    // Debounce to avoid multiple rapid calls
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      // Remove old panels so they get re-rendered fresh
      document.getElementById('pbf-panel')?.remove();
      document.getElementById('pbf-detail-panel')?.remove();
      renderBodyFieldsPanel();
    }, 300);
  }

  function onPerformerDetailPage() {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      document.getElementById('pbf-panel')?.remove();
      // Always start as view mode; the MutationObserver on .detail-header
      // handles switching to edit mode when the user clicks Edit
      waitForDetailAndRender();
    }, 300);
  }

  function watchNavigation() {
    const checkUrl = () => {
      const url = window.location.href;
      if (url !== lastUrl) {
        lastUrl = url;
        if (isPerformersListPage()) {
          document.getElementById('pbf-detail-panel')?.remove();
          onPerformersPage();
        } else if (isPerformerDetailPage()) {
          document.getElementById('pbf-panel')?.remove();
          onPerformerDetailPage();
        } else {
          // Navigated away — clean up both panels
          document.getElementById('pbf-panel')?.remove();
          document.getElementById('pbf-detail-panel')?.remove();
        }
      }
    };

    setInterval(checkUrl, 150);
  }

  // ─── Init ─────────────────────────────────────────────────────────────────

  function init() {
    // Always use navigation polling — it's reliable and lightweight
    watchNavigation();

    // Also hook into the stash library if available for better event timing
    let hookAttempts = 0;
    const tryHook = () => {
      if (window.stash7dJx1qP?.stash) {
        const { stash } = window.stash7dJx1qP;
        stash.addEventListener('page:performers', () => onPerformersPage());
        // page:performer fires on initial load — always view mode first
        stash.addEventListener('page:performer', () => onPerformerDetailPage());
        // page:performer:any also fires; ignore duplicates via debounce
        return;
      }
      hookAttempts++;
      if (hookAttempts < 30) {
        setTimeout(tryHook, 300);
      }
    };
    tryHook();

    // Run immediately if already on the right page
    if (isPerformersListPage()) {
      onPerformersPage();
    } else if (isPerformerDetailPage()) {
      onPerformerDetailPage();
    }
  }

  function isPerformersListPage() {
    // Exactly /performers or /performers/ (not /performers/123)
    return /^\/performers\/?$/.test(window.location.pathname);
  }

  function isPerformerDetailPage() {
    // /performers/123 or /performers/123/scenes etc
    return /^\/performers\/\d+/.test(window.location.pathname);
  }

  // Wait for DOM to be ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
