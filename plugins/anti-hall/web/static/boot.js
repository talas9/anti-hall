// Loads the page's WASM for the chosen tier. The Full build carries the WebGPU layer; the Lite build does not. The choice is the
// person's header toggle (kept in the browser), else the server's start tier; `auto` is Lite when the browser asks for reduced motion.
const boot = JSON.parse(document.getElementById("boot")?.textContent || "{}");
// the colour scheme before the page draws: the person's header choice, else the server's start (web.theme); `system` leaves it to the
// computer's setting (no data-theme). The page keeps it in step from then on.
let theme = null;
try { theme = localStorage.getItem("ah-theme"); } catch (_) { /* storage blocked: use the server's start */ }
if (!["system", "light", "dark"].includes(theme)) theme = boot.theme || "system";
// the scheme to use on `system` when the computer reports no preference (read by the page's one dark/light check)
document.documentElement.setAttribute("data-theme-default", boot.theme === "light" ? "light" : "dark");
if (theme === "system") document.documentElement.removeAttribute("data-theme"); else document.documentElement.setAttribute("data-theme", theme);
let saved = null;
try { saved = localStorage.getItem("ah-mode"); } catch (_) { /* storage blocked: use the server's start tier */ }
const mode = ["auto", "full", "lite"].includes(saved) ? saved : boot.mode || "auto";
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const tier = mode === "lite" || (mode === "auto" && reduce) ? "lite" : "full";
try {
  const page = await import(`/pkg/${tier}/ah_web_ui.js`);
  await page.default({ module_or_path: `/pkg/${tier}/ah_web_ui_bg.wasm` });
} catch (e) {
  const m = document.getElementById("boot-error");
  if (m) { m.hidden = false; m.textContent = "Dashboard failed to start: " + e; }
}
