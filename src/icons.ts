// Icônes au trait (24×24), dessinées en currentColor.
const svg = (body: string, cls = 'icon') =>
  `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"
    stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

export const ICONS = {
  gathering: svg('<path d="M4 20l9-9"/><path d="M7 5.5c4.5-2.5 9.5-2 13 1.5-2-.6-4.6-.5-7 .8"/><path d="M18.5 17c2.5-4.5 2-9.5-1.5-13 .6 2 .5 4.6-.8 7"/><path d="M11.5 8.5l4 4"/>'),
  weapon: svg('<path d="M14.5 17.5L3 6V3h3l11.5 11.5"/><path d="M13 19l6-6"/><path d="M16 16l4 4"/><path d="M19 21l2-2"/>'),
  accessory: svg('<path d="M6 3h12l4 6-10 12L2 9z"/><path d="M11 3L8 9l4 12 4-12-3-6"/><path d="M2 9h20"/>'),
  armor: svg('<path d="M8 3L3 6l2 5 2-1v10h10V10l2 1 2-5-5-3c-.6 2-2.2 3-4 3s-3.4-1-4-3z"/><path d="M12 9v11"/>'),
  material: svg('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18v3h3l6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/><path d="M15 15l5 5"/><path d="M17.5 12.5l4 4-1 1"/>'),
  stats: svg('<path d="M4 20V11"/><path d="M10 20V5"/><path d="M16 20v-7"/><path d="M21 20H3"/>'),
  upload: svg('<path d="M12 16V4"/><path d="M7 9l5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>'),
  up: svg('<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>', 'icon arrow'),
  down: svg('<path d="M12 5v14"/><path d="M6 13l6 6 6-6"/>', 'icon arrow'),
  chevron: svg('<path d="M6 9l6 6 6-6"/>', 'icon chevron'),
};
