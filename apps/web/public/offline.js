// Tela offline: botão "Tentar de novo" e recarga automática quando a rede volta.
// Fica num arquivo para a CSP não precisar de script inline (ver public/_headers).
document.getElementById("retry").addEventListener("click", function () {
  location.reload();
});
window.addEventListener("online", function () {
  location.reload();
});
