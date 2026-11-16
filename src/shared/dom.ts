import { contrastText, escapeHtml, initials } from "./common";

/**
 * Constructed stylesheets are applied through the CSSOM, so a page's
 * Content-Security-Policy (style-src) can't block them the way it can block
 * <style> elements or inline style="" attributes.
 */
export function sheet(css: string): CSSStyleSheet {
  const s = new CSSStyleSheet();
  s.replaceSync(css);
  return s;
}

/** Avatar markup; colours are applied later by paintAvatars() (CSP-safe). */
export function avatarHtml(name: string, color: string, cls = "av"): string {
  return `<span class="${cls}" data-bg="${escapeHtml(color)}">${escapeHtml(initials(name))}</span>`;
}

export function paintAvatars(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>("[data-bg]").forEach((el) => {
    const bg = el.dataset.bg!;
    el.style.background = bg;
    if (/^#[0-9a-f]{6}$/i.test(bg)) el.style.color = contrastText(bg);
  });
}
