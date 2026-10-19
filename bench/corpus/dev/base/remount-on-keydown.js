// A client re-mount: the first keydown anywhere re-renders <main> from its own markup, as a framework does when it
// hydrates or re-keys a subtree, so every control in it is a new node from then on. The controls work before and
// after: their handlers are delegated to the document, not bound to the nodes that get replaced.
(function () {
  var app = document.getElementById("app");
  var status = document.getElementById("status");
  var remounted = false;
  function act(control) {
    status.textContent =
      control.dataset.action === "buy" ? "Bought" : "Added to cart";
  }
  document.addEventListener("keydown", function () {
    if (remounted) return;
    remounted = true;
    app.innerHTML = app.innerHTML;
  });
  document.addEventListener("click", function (e) {
    var control = e.target.closest("[data-action]");
    if (control) act(control);
  });
  document.addEventListener("keydown", function (e) {
    var control = e.target.closest('[role="button"][data-action]');
    if (control && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      act(control);
    }
  });
})();
