import { PDFPageView } from "./page_view.js";


// this helps with template literals highlighting on some editors
const html = String.raw;

/**
  * Render modes
  * @readonly
  * @enum {number}
  */
const RenderModes = {
  single: 0,
  all: 1
};


/**
  * Render states
  * @readonly
  * @enum {number}
  */
const RenderStates = {
  initial: 0,
  rendering: 1,
  paused : 2,
  finished: 3,
};


// use "text/xml" and get firstElementChild so that
// <head> and <body> will not be generated
const LoaderElement = new DOMParser().parseFromString(html`
  <div class="loader">
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="24"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width="3"
      stroke-linecap="round"
      stroke-linejoin="round"
      class="loader-size"
    >
      <path stroke="none" d="M0 0h24v24H0z" fill="none"/>
      <path d="M12 6l0 -3" /><path d="M16.25 7.75l2.15 -2.15" />
      <path d="M18 12l3 0" /><path d="M16.25 16.25l2.15 2.15" />
      <path d="M12 18l0 3" /><path d="M7.75 16.25l-2.15 2.15" />
      <path d="M6 12l-3 0" /><path d="M7.75 7.75l-2.15 -2.15" />
    </svg>
  </div>
`, "text/xml").firstElementChild;

/**
  * use binary search to find the first visible page
  * @param {PDFPageView} views
  */
function binarySearchFirstPageView(views, condition, start = 0) {
  let minIdx = start;
  let maxIdx = views.length - 1;

  if (maxIdx < 0 || !condition(views[maxIdx])) {
    return views.length;
  }
  if (condition(views[minIdx])) {
    return minIdx;
  }

  while (minIdx < maxIdx) {
    const currentIdx = (minIdx + maxIdx) >> 1;
    const currentView = views[currentIdx];
    if (condition(currentView)) {
      maxIdx = currentIdx;
    } else {
      minIdx = currentIdx + 1;
    }
  }
  return minIdx;
}


/**
  * @typedef {import("./viewer.js").VisiblePageViews} VisiblePageViews
  */
/**
  * getting the visible pages and some pages to pre render
  * @returns {VisiblePageViews} The visible and pre render elements
  */
function getVisibleElements({
  scrollElement,
  views,
  sortByVisibility = true,
}) {
  const top = scrollElement.scrollTop + scrollElement.offsetTop,
    bottom = top + scrollElement.clientHeight;
  // const left = scrollElement.scrollLeft, right = left + scrollElement.clientWidth;

  function isElementVisibleFromTop(view) {
    const el = view.pageContainer;
    const elBottom = el.offsetTop + el.clientTop + el.clientHeight;

    return elBottom > top;
  }

  function isElementVisibleFromBottom(view) {
    const el = view.pageContainer;
    const elTop = el.offsetTop + el.clientTop;

    return elTop < bottom;
  }

  /**
    * get the percentage of a page view that is shown
    * @param {PDFPageView} pageView the page view
    */
  function getViewPercentage(pageView) {
    const page = pageView.pageContainer;
    const viewHeight = page.clientHeight;
    const viewTop = page.offsetTop + page.clientTop;
    const viewBottom = viewTop + page.clientHeight;

    const hiddenHeight =
      Math.max(0, top - viewTop) + Math.max(0, viewBottom - bottom);

    const fractionHeight = (viewHeight - hiddenHeight) / viewHeight;

    // bitwise OR to convert float to int
    return (fractionHeight * 100) | 0;
  }

  let visible = [];
  const preRenderViews = [];

  const firstVisiblePageIdx = binarySearchFirstPageView(views, isElementVisibleFromTop);
  visible.push({
    view: views[firstVisiblePageIdx],
    percent: getViewPercentage(views[firstVisiblePageIdx]),
  });

  // find subsequent visible page views and pre render view
  for (let i = firstVisiblePageIdx + 1; i < views.length; i++) {
    if (isElementVisibleFromBottom(views[i])) {
      const percent = getViewPercentage(views[i]);
      visible.push({
        view: views[i],
        percent,
      });
      continue;
    }

    // pre render views;
    preRenderViews.push(views[i]);
    break;
  }

  // backtrack to find visible views and pre render views
  // probably unnecessary but just to be sure
  for (let i = firstVisiblePageIdx - 1; i >= 0; i--) {
    if (isElementVisibleFromTop(views[i])) {
      const percent = getViewPercentage(views[i]);
      visible.push({
        view: views[i],
        percent,
      });
      continue;
    }

    // pre render views;
    preRenderViews.push(views[i]);
    break;
  }

  if (sortByVisibility) {
    visible.sort((a, b) => {
      const pc = a.percent - b.percent;
      if (Math.abs(pc) > 0.001) {
        return -pc;
      }
      return a.id - b.id; // ensure stability
    })
  }
  visible = visible.map((view) => view.view);

  return { visible, preRenderViews };
}

class OutputScale {
  constructor() {
    const pixelRatio = window.devicePixelRatio || 1;
    this.sx = pixelRatio;
    this.sy = pixelRatio;
  }

  get scaled() {
    return this.sx !== 1 || this.sy !== 1;
  }
}

function approximateFraction(x) {
  // Fast paths for int numbers or their inversions.
  if (Math.floor(x) === x) {
    return [x, 1];
  }
  const xinv = 1 / x;
  const limit = 8;
  if (xinv > limit) {
    return [1, limit];
  } else if (Math.floor(xinv) === xinv) {
    return [1, xinv];
  }

  const x_ = x > 1 ? xinv : x;
  // a/b and c/d are neighbours in Farey sequence.
  let a = 0,
    b = 1,
    c = 1,
    d = 1;
  // Limiting search to order 8.
  while (true) {
    // Generating next term in sequence (order of q).
    const p = a + c,
      q = b + d;
    if (q > limit) {
      break;
    }
    if (x_ <= p / q) {
      c = p;
      d = q;
    } else {
      a = p;
      b = q;
    }
  }
  let result;
  // Select closest of the neighbours to x.
  if (x_ - a / b < c / d - x_) {
    result = x_ === x ? [a, b] : [b, a];
  } else {
    result = x_ === x ? [c, d] : [d, c];
  }
  return result;
}

function roundToDivide(x, div) {
  const r = x % div;
  return r === 0 ? x : Math.round(x - r + div);
}

export {
  html,
  RenderModes,
  RenderStates,
  getVisibleElements,
  OutputScale,
  approximateFraction,
  roundToDivide,
  LoaderElement
}
