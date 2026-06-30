(function () {
  "use strict";

  const nav = document.getElementById("landing-nav");
  const menuBtn = document.getElementById("landing-menu-btn");
  const mobileMenu = document.getElementById("landing-mobile-menu");
  const previewCard = document.getElementById("landing-preview-card");

  function onScroll() {
    if (!nav) return;
    nav.classList.toggle("is-scrolled", window.scrollY > 24);
  }

  function toggleMobileMenu(open) {
    if (!menuBtn || !mobileMenu) return;
    const next = typeof open === "boolean" ? open : !mobileMenu.classList.contains("is-open");
    mobileMenu.classList.toggle("is-open", next);
    mobileMenu.hidden = !next;
    menuBtn.setAttribute("aria-expanded", String(next));
  }

  if (menuBtn && mobileMenu) {
    menuBtn.addEventListener("click", () => toggleMobileMenu());
    mobileMenu.querySelectorAll("a").forEach((link) => {
      link.addEventListener("click", () => toggleMobileMenu(false));
    });
  }

  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  const revealEls = document.querySelectorAll(".landing-reveal");
  if ("IntersectionObserver" in window && revealEls.length) {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            io.unobserve(entry.target);
          }
        });
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.12 }
    );
    revealEls.forEach((el) => io.observe(el));
  } else {
    revealEls.forEach((el) => el.classList.add("is-visible"));
  }

  if (previewCard) {
    previewCard.addEventListener("pointerenter", () => {
      previewCard.style.transform = "translateY(-2px)";
    });
    previewCard.addEventListener("pointerleave", () => {
      previewCard.style.transform = "";
    });
  }
})();
