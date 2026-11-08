// Both native shells load the app from the filesystem, so nothing may render on
// a server. SPA mode also lets the Tauri API run inside load functions.
export const ssr = false;
export const prerender = false;
