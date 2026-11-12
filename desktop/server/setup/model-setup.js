const form = document.querySelector("form");
const button = form.querySelector("button");
const alert = document.querySelector("#setup-error");
const endpoint = "/api/desktop/model-setup";
const openFolio = () => location.replace("/prototype/immersive-exhibition/light.html#home");

fetch(endpoint, { cache: "no-store" })
  .then(response => response.ok ? response.json() : null)
  .then(status => { if (status?.configured) openFolio(); })
  .catch(() => {});

form.addEventListener("submit", async event => {
  event.preventDefault();
  button.disabled = true;
  button.textContent = "正在验证…";
  alert.hidden = true;
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(Object.fromEntries(new FormData(form))),
    });
    const status = await response.json();
    if (!response.ok || !status.configured) throw new Error(status.error || "模型验证未完成，请重试。");
    form.reset();
    openFolio();
  } catch (error) {
    alert.textContent = error.message || "无法连接本地服务，请重试。";
    alert.hidden = false;
    button.disabled = false;
    button.textContent = "验证并进入 Folio";
  }
});
