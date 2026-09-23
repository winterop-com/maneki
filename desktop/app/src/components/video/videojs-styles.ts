/**
 * The player's two stylesheets, in the order they have to land.
 *
 * THE THEME HAS TO COME AFTER THE BASE. Both sheets set the control bar's height at the same
 * specificity, so whichever the document receives last wins. Asked for as two separate dynamic
 * imports they arrive in whatever order the network finishes them, and about half the time the
 * base sheet lands second: its 3em height then overrides the theme's 70px, the theme's 20px of
 * padding is still there, and what is left is a 10px strip whose icons sit below the clipped
 * edge -- a player with no visible controls. One module importing both fixes the order once.
 */
import 'video.js/dist/video-js.css'
import '@videojs/themes/dist/city/index.css'
