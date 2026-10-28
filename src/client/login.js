const form = document.querySelector("#login-form");
const message = document.querySelector("#login-message");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const submit = form.querySelector("button[type=submit]");
  submit.disabled = true;
  message.hidden = true;
  try {
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: new FormData(form).get("password") }),
    });
    if (!response.ok) throw new Error("Password non corretta.");
    const candidate = new URLSearchParams(location.search).get("next") || "/admin";
    location.replace(/^\/admin(?:\/|$)/u.test(candidate) ? candidate : "/admin");
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : "Accesso non riuscito.";
    message.hidden = false;
    submit.disabled = false;
  }
});
