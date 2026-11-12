const form = document.querySelector("#login-form");
const username = form.elements.username;
const password = form.elements.password;
const submit = form.querySelector(".login-submit");
const toggle = document.querySelector("#password-toggle");
const message = document.querySelector("#login-message");
const prefillNote = document.querySelector("#login-prefill-note");
const url = new URL(location.href);
const next = url.searchParams.get("next");
const destination = next && url.hash ? next + url.hash : next;

function showMessage(value) {
  message.textContent = value;
  message.hidden = !value;
}

toggle.addEventListener("click", () => {
  const show = password.type === "password";
  password.type = show ? "text" : "password";
  toggle.textContent = show ? "隐藏" : "显示";
  toggle.setAttribute("aria-label", show ? "隐藏密码" : "显示密码");
});
toggle.setAttribute("aria-label", "显示密码");

form.addEventListener("submit", async event => {
  event.preventDefault();
  if (submit.disabled) return;
  submit.disabled = true;
  form.setAttribute("aria-busy", "true");
  showMessage("");
  try {
    const response = await fetch("/api/desktop/session", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: username.value, password: password.value, next: destination }),
    });
    const result = await response.json();
    if (!response.ok) { showMessage(result.error || "登录未完成，请重试。"); return; }
    location.replace(result.next);
  } catch { showMessage("暂时无法连接 Folio，请重试。"); }
  finally { submit.disabled = false; form.removeAttribute("aria-busy"); }
});

try {
  const response = await fetch("/api/desktop/session", { cache: "no-store" });
  if (!response.ok) throw new Error();
  const defaults = await response.json();
  if (defaults.signedIn) location.replace("/");
  else {
    username.value = defaults.username;
    password.value = defaults.password;
    prefillNote.hidden = false;
    submit.disabled = false;
  }
} catch { showMessage("暂时无法打开演示账号，请重新加载页面。"); }
