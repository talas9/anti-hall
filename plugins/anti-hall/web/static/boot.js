import init from "/pkg/ah_web_ui.js";
init().catch((e) => {
  const m = document.getElementById("boot-error");
  if (m) { m.hidden = false; m.textContent = "Dashboard failed to start: " + e; }
});
