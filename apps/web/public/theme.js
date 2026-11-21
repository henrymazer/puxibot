// Aplica o tema escolhido antes da primeira pintura (carregado de forma síncrona no <head>,
// sem `defer`), para não piscar o tema errado. Fica num arquivo para a CSP não precisar de
// script inline (ver public/_headers).
try {
  var t = localStorage.getItem("tb-theme");
  if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
} catch (e) {}
