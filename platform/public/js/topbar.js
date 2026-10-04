/**
 * The top bar: the menus from menuDef.js with their dropdowns, then the
 * icons for daily work and the cog. One dropdown is open at a time; it
 * closes on Escape, on a click outside the bar and once an entry is chosen.
 */

import { el, esc } from './base.js';
import { can } from './access.js';
import { entryFor, visibleMenus, visibleRight } from './menuDef.js';

let openKey = null;
let onChoose = () => {};

const ICONS = {
  tasks: '<path d="M4 6h16M4 12h16M4 18h10" />',
  teller: '<rect x="3" y="6" width="18" height="12" rx="2" /><circle cx="12" cy="12" r="3" />',
  till: '<rect x="3" y="9" width="18" height="11" rx="1" /><path d="M7 9V5h10v4M8 14h8" />',
  cog: '<circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" />',
};
const icon = (name) => `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${ICONS[name] || ''}</svg>`;

/** Close the open dropdown, if any. */
export function closeMenus() {
  if (!openKey) return;
  const list = el('nav').querySelector(`[data-dropdown="${openKey}"]`);
  if (list) list.hidden = true;
  el('nav').querySelector(`[data-menu="${openKey}"]`)?.setAttribute('aria-expanded', 'false');
  openKey = null;
}

/** Put the open list under its button. */
function place(key) {
  const list = el('nav').querySelector(`[data-dropdown="${key}"]`);
  const r = el('nav').querySelector(`[data-menu="${key}"]`).getBoundingClientRect();
  const n = el('nav').getBoundingClientRect();
  list.style.top = `${Math.round(r.bottom - n.top + 2)}px`;
  list.style.left = `${Math.round(Math.max(0, Math.min(r.left - n.left, window.innerWidth - n.left - list.offsetWidth - 4)))}px`;
}

function openMenu(key) {
  closeMenus();
  const list = el('nav').querySelector(`[data-dropdown="${key}"]`);
  if (!list) return;
  list.hidden = false;
  place(key);
  el('nav').querySelector(`[data-menu="${key}"]`).setAttribute('aria-expanded', 'true');
  openKey = key;
}

/** Draw the bar for the signed-in user. choose(view, filter) opens what an entry names. */
export function drawTopbar(choose) {
  onChoose = choose;
  wire();
  const menus = visibleMenus(can);
  const right = visibleRight(can);
  // The dropdowns sit outside the row of menus, placed under their button when opened.
  el('nav').innerHTML = `<div class="menus">${menus.map((m) => (m.open
    ? `<button data-menu="${esc(m.key)}" data-entry="${esc(m.key)}">${esc(m.label)}</button>`
    : `<button data-menu="${esc(m.key)}" aria-haspopup="menu" aria-expanded="false">${esc(m.label)}</button>`)).join('')}</div>
    <div class="icons">${right.map((e) => `<button class="icon" data-entry="right.${esc(e.key)}" aria-label="${esc(e.label)}" title="${esc(e.label)}">${icon(e.icon)}</button>`).join('')}</div>
    ${menus.filter((m) => !m.open).map((m) => `<ul role="menu" data-dropdown="${esc(m.key)}" aria-label="${esc(m.label)}" hidden>${m.entries.map((e) => `<li class="${e.divider ? 'divider' : ''}" role="none">
      <button role="menuitem" data-entry="${esc(m.key)}.${esc(e.key)}">${esc(e.label)}</button></li>`).join('')}</ul>`).join('')}`;
  openKey = null;
}

function entryOf(ref) {
  const [menu, key] = ref.split('.');
  if (menu === 'right') return visibleRight(can).find((e) => e.key === key);
  const m = visibleMenus(can).find((x) => x.key === menu);
  if (!m) return null;
  return m.open || m.entries.find((e) => e.key === key);
}

/** Mark the menu (or icon) that opens a view with a filter. */
export function markActive(view, filter) {
  const hit = entryFor(view, filter);
  for (const b of el('nav').querySelectorAll('[data-menu], [data-entry^="right."]')) {
    const key = b.dataset.menu || b.dataset.entry;
    b.classList.toggle('active', hit ? key === hit.menu : key === `right.${view === 'admin' ? 'admin' : view}`);
  }
}

// One set of listeners for the life of the page, added on the first draw
// (not at load: the modules import each other, and the DOM helpers may not be ready yet).
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  el('nav').addEventListener('click', (e) => {
    const entry = e.target.closest('[data-entry]');
    if (entry) {
      const def = entryOf(entry.dataset.entry);
      closeMenus();
      if (def) onChoose(def.view, def.filter ? { ...def.filter } : {});
      return;
    }
    const menu = e.target.closest('[data-menu]');
    if (menu) {
      if (openKey === menu.dataset.menu) closeMenus(); else openMenu(menu.dataset.menu);
    }
  });

  el('nav').addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { const k = openKey; closeMenus(); if (k) el('nav').querySelector(`[data-menu="${k}"]`)?.focus(); return; }
    if (!openKey || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
    e.preventDefault();
    const items = [...el('nav').querySelectorAll(`[data-dropdown="${openKey}"] [role=menuitem]`)];
    const at = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown' ? (at + 1) % items.length : (at <= 0 ? items.length - 1 : at - 1);
    items[next]?.focus();
  });

  document.addEventListener('click', (e) => { if (openKey && !el('nav').contains(e.target)) closeMenus(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && openKey) closeMenus(); });
  window.addEventListener('resize', closeMenus);
}
