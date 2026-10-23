// Loads the page's WASM for the chosen tier. The Full build carries the WebGPU layer; the Lite build does not. The choice is the
// person's header toggle (kept in the browser), else the server's start tier; `auto` is Lite when the browser asks for reduced motion.
const boot = JSON.parse(document.getElementById("boot")?.textContent || "{}");
let saved = null;
try { saved = localStorage.getItem("ah-mode"); } catch (_) { /* storage blocked: use the server's start tier */ }
const mode = ["auto", "full", "lite"].includes(saved) ? saved : boot.mode || "auto";
const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
const tier = mode === "lite" || (mode === "auto" && reduce) ? "lite" : "full";
try {
  const page = await import(`/pkg/${tier}/ah_web_ui.js`);
  await page.default();
} catch (e) {
  const m = document.getElementById("boot-error");
  if (m) { m.hidden = false; m.textContent = "Dashboard failed to start: " + e; }
}
