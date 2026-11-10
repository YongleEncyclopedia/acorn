/**
 * The reading fonts: Literata, Noto Serif SC and LXGW WenKai Screen, each cut into ~100 unicode-range subsets.
 * Their @font-face rules alone are three times the size of the app's own stylesheet, so they are loaded as a
 * separate stylesheet that does not hold up the first paint (see main.tsx). Text shows in the system's serif
 * and kai faces until the subsets it needs arrive, exactly as `font-display: swap` already made it do.
 */
import "@fontsource-variable/literata/wght.css";
import "@fontsource-variable/literata/wght-italic.css";
import "@fontsource/noto-serif-sc/400.css";
import "@fontsource/noto-serif-sc/700.css";
import "lxgw-wenkai-screen-webfont/lxgwwenkaiscreen.css";
