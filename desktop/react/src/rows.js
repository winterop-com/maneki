// Keyboard operability for row-shaped things: a nav item, an artist, an
// album, a track, a station. Spread `chooses(fn)` onto the row element
// beside its onClick and the row takes focus in the tab order and
// answers Enter and Space with the same action. The target check keeps
// a control nested inside the row (the star button) from firing the row
// as well as itself. `current` marks the row that is selected or playing
// with aria-current, which is what a screen reader reads for ".active".
export function chooses(onChoose, { current = false } = {}) {
  return {
    tabIndex: 0,
    "aria-current": current ? "true" : undefined,
    onKeyDown: (e) => {
      if (e.target !== e.currentTarget) return;
      if (e.key !== "Enter" && e.key !== " ") return;
      e.preventDefault();
      onChoose(e);
    },
  };
}
