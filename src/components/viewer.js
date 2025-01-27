import * as pdfjsLib from "pdfjs-dist"
import { LoaderElement, RenderModes, RenderStates, getVisibleElements } from "./utils"
import { PDFPageView } from "./page_view"
import { PDFRenderQueue } from "./render_queue";


/**
  * @typedef {import("pdfjs-dist").PDFDocumentProxy} PDFDocumentProxy
  */
/**
  * @typedef {Object} VisiblePageViews
  * @property {PDFPageView[]} visible page views to render
  * @property {PDFPageView[]} preRenderViews page views to pre render
  */

const DEFAULT_CACHE_SIZE = 10;

// PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = '/node_modules/pdfjs-dist/build/pdf.worker.mjs';

class PDFViewBuffer {
  /** @type {Set} **/
  #buffer = new Set();
  /** @type {number} **/
  #size = 0;

  constructor(size) {
    this.#size = size;
  }

  /**
    * add new page view to the buffer and remove old items if size exceeded
    * @param {PDFPageView} pageView the page view to add
    */
  push(pageView) {
    const buffer = this.#buffer;

    // move the item to the end of buffer if exists
    if (buffer.has(pageView)) {
      buffer.delete(pageView);
    }
    buffer.add(pageView);

    if (buffer.size > this.#size) {
      this.#destroyFirst();
    }
  }

  has(pageView) {
    return this.#buffer.has(pageView);
  }

  resize(newSize) {
  }

  /**
    * destroy the first item in the buffer
    */
  #destroyFirst() {
    const pageView = this.#buffer.keys().next().value;

    pageView?.destroy();
    this.#buffer.delete(pageView);
  }
}

/**
  * PDF viewer
  */
class PDFViewer {
  /** @type {PDFViewBuffer} **/
  #buffer = null;
  /** @type {PDFPageView[]} **/
  #pages = null;
  metadata = null;
  /** @type {string} **/
  filename = null;
  /** @type {PDFDocumentProxy} **/
  pdfDocument = null;
  /** @type {import("pdfjs-dist").PDFDocumentLoadingTask} **/
  pdfLoadingTask = null;
  /** @type {number} **/
  #currentPage = 0;
  /** @type {number} **/
  #currentNumPages = 0;
  /** @type {HTMLElement} **/
  mainContainer = null;
  /** @type {HTMLElement} **/
  pdfContainer = null;
  /** @type {HTMLElement} **/
  pageNumElement = null;
  /** @type {HTMLElement} **/
  pageInputElement = null;
  /** @type {HTMLElement} **/
  totalPageNumElement = null;
  /** @type {HTMLElement} **/
  closeButton = null;
  /** @type {HTMLElement} **/
  prevButton = null;
  /** @type {HTMLElement} **/
  nextButton = null;
  /** @type {HTMLElement} **/
  renderModeButton = null;
  /** @type {HTMLElement} **/
  renderSingle = null;
  /** @type {HTMLElement} **/
  renderAll = null;
  /** @type {HTMLElement} **/
  prevPageButton = null;
  /** @type {HTMLElement} **/
  nextPageButton = null;
  /** @type {HTMLElement} **/
  overlay = null;
  /** @type {number} **/
  #maxCanvasPixels = null;
  /** @type {PDFRenderQueue} **/
  #renderQueue = null;
  /** @type {RenderModes} **/
  currentRenderMode = null;
  /** @type {number} **/
  #scale = null;

  constructor() {
    this.#maxCanvasPixels = 2 ** 25;
    this.#renderQueue = new PDFRenderQueue(this);

    this.mainContainer = document.getElementById("pdf-viewer");
    this.pdfContainer = document.getElementById("pdf-container");
    this.pageNumElement = document.getElementById("page-num");
    this.pageInputElement = document.getElementById("page-input");
    this.totalPageNumElement = document.getElementById("total-page-num");
    this.closeButton = document.getElementById("close-button");
    this.prevButton = document.getElementById("prev");
    this.nextButton = document.getElementById("next");
    this.renderModeButton = document.getElementById("render-mode-button");
    this.renderAll = document.getElementById("all");
    this.renderSingle = document.getElementById("single");
    this.prevPageButton = document.getElementById("prev");
    this.nextPageButton = document.getElementById("next");
    this.overlay = document.getElementById("overlay");
    this.fileName = document.getElementById("pdf-name");

    this.bindEvents();

    this.#reset();
  }


  bindEvents() {
    // button actions
    this.prevButton.onclick = this.prevPage.bind(this);
    this.nextButton.onclick = this.nextPage.bind(this);
    this.renderModeButton.onclick = this.nextRenderMode.bind(this);
    this.closeButton.onclick = this.closePDFViewer.bind(this);

    // const hasScrollEndEvent = ("onscrollend" in window);
    const handleScroll = () => {
      if (this.currentRenderMode === RenderModes.single) return;
      this.update();
    }
    this.pdfContainer.addEventListener(
      // hasScrollEndEvent ? "scrollend" : "scroll",
      "scroll",
      handleScroll.bind(this),
      {
        passive: true,
      }
    );

    const onInputChange = (e) => {
      e.target.blur();

      const inputLength = e.target.value.length;

      if (
        inputLength === 0 ||
        parseInt(e.target.value) > this.#currentNumPages
      ) {
        this.pageInputElement.value = this.currentPage;

        const len = this.pageInputElement.value.length;
        const style = window.getComputedStyle(e.target);
        const minWidth = parseInt(style.minWidth),
          maxWidth = parseInt(style.maxWidth);

        e.target.style.width = Math.min((minWidth * len), maxWidth) + 'px';
        return;
      }

      this.jumpToPage(parseInt(e.target.value));
    }
    this.pageInputElement.addEventListener(
      "change", onInputChange.bind(this), { passive: true }
    );
  }


  closePDFViewer() {
    if (!this.mainContainer.classList.contains("active")) return;
    this.mainContainer.classList.remove("active");
    this.overlay.classList.remove("active");

    this.close();
  }


  /**
    * open the document - to be changed when we connects with the backend
    * @param {string} url the string of the url object
    */
  open(url, filename) {
    if (this.pdfLoadingTask) this.close();
    this.pdfLoadingTask = pdfjsLib.getDocument(url);
    this.filename = filename;

    this.fileName.innerHTML = filename;

    // this has to happend first so update() and subsequent functions
    // can access the pages' container elements
    this.mainContainer.classList.add("active");
    this.overlay.classList.add("active");
    this.pdfContainer.prepend(LoaderElement);

    this.pdfLoadingTask.promise.then(
      async (pdfDocument) => {
        this.pdfContainer.firstElementChild.remove();
        await this.load(pdfDocument);

        this.updateRenderMode();
        this.update();
      }
    );
  }


  get renderQueue() {
    return this.#renderQueue;
  }

  get maxCanvasPixels() {
    return this.#maxCanvasPixels;
  }


  get scale() {
    return this.#scale;
  }

  set scale(newScale) {
    this.#scale = newScale;

    this.update();
  }


  /**
    * load the document
    * @param {PDFDocumentProxy} pdfDocument the pdf document
    */
  async load(pdfDocument) {
    this.pdfDocument = pdfDocument;
    this.#currentNumPages = pdfDocument.numPages;
    pdfDocument.getMetadata().then((metadata) => {
      this.metadata = metadata;
    })

    const pagesPromise = [];

    // get the pages
    for (let i = 1; i <= pdfDocument.numPages; i++) {
      pagesPromise.push(pdfDocument.getPage(i));
    }
    this.#currentPage = 1;

    // load the pages
    return Promise.all(pagesPromise).then(
      async ([...pages]) => {
        pages.forEach((page) => {
          this.#pages.push(new PDFPageView({
            page,
            pdfViewer: this,
            renderQueue:this.#renderQueue,
          }));
        })
      }
    )
  }


  get currentPage() {
    return this.#currentPage;
  }

  set currentPage(pageNum) {
    this.#currentPage = pageNum;
  }


  /**
    * update the buffer
    * @param {PDFPageView} pageView the page view to update
    */
  #updateBuffer(pageView) {
    this.#buffer.push(pageView);
  }


  /**
    * update the viewer state
    */
  update() {
    const { visible, preRenderViews } = this.#getVisiblePageViews();

    this.currentPage = visible[0].id;
    this.pageInputElement.value = this.#currentPage
    this.totalPageNumElement.innerHTML = this.#currentNumPages;

    [...visible, ...preRenderViews].forEach(
      async (pageView) => {
        switch (pageView.renderState) {
          case RenderStates.finished:
            return;
          case RenderStates.paused:
            pageView.resume();
            break;
          case RenderStates.rendering:
            break;
          case RenderStates.initial:
            await pageView.render(this.#updateBuffer.bind(this));
            break;
        }
      }
    )
  }


  /**
    * move the focus to the specified page
    * @param {number=} pageNum the page number to move to
    */
  jumpToPage(pageNum) {
    if (pageNum > this.#currentNumPages) return;

    switch (this.currentRenderMode) {
      case RenderModes.single:
        if (pageNum) this.currentPage = pageNum;
        this.update();
        break;
      case RenderModes.all:
        const page =
          this.#pages[(pageNum ? pageNum : this.currentPage) - 1].pageContainer;

        // scroll the container to page
        this.pdfContainer.scrollTop =
          page.offsetTop -
          // move the page slightly down
        parseInt(window.getComputedStyle(this.pdfContainer).gap) / 2;
        break;
    }
  }


  /**
    * getting the visible pages and some pages to pre render
    * @returns {VisiblePageViews} The visible and pre render page views
    */
  #getVisiblePageViews() {
    switch (this.currentRenderMode) {
      case RenderModes.single:
        const visible = [this.#pages[this.currentPage - 1]];
        const preRenderViews = [];

        if (this.currentPage - 1 >= 1) {
          preRenderViews.push(this.#pages[this.currentPage - 2]);
        }
        if (this.currentPage + 1 <= this.#currentNumPages) {
          preRenderViews.push(this.#pages[this.currentPage]);
        }

        Array.from(this.pdfContainer.childNodes).forEach((node) => node.remove());
        visible.forEach(
          (view) => this.pdfContainer.appendChild(view.pageContainer)
        );

        return {
          visible,
          preRenderViews
        }
      case RenderModes.all:
        const views = this.#pages;

        return getVisibleElements({
          scrollElement: this.pdfContainer,
          views,
        });
    }
  }


  async close() {
    if (!this.pdfLoadingTask) return;

    const promises = [];

    promises.push(this.pdfLoadingTask.destroy());
    this.pdfLoadingTask = null;

    this.#reset();
    this.pdfDocument.destroy();
    this.pdfDocument = null;
    Array.from(this.pdfContainer.childNodes).forEach((node) => node.remove());

    await Promise.all(promises);
  }


  nextPage() {
    if (this.#currentPage === this.#currentNumPages) return;
    if (this.#currentPage > this.#currentNumPages) {
      this.#currentPage = this.#currentNumPages;
      return;
    }

    this.#currentPage++;
    this.jumpToPage();
  }


  prevPage() {
    const FIRST_PAGE = 1;
    if (this.#currentPage === FIRST_PAGE) return;
    if (this.#currentPage < FIRST_PAGE) {
      this.#currentPage = FIRST_PAGE;
      return;
    }

    this.#currentPage--;
    this.jumpToPage();
  }


  /**
    * change to the next available render mode
    */
  nextRenderMode() {
    const modes = Object.keys(RenderModes);
    const newRenderMode = (this.currentRenderMode + 1) % modes.length;

    switch (newRenderMode) {
      case RenderModes.single:
        this.renderSingle.classList.add("active");
        this.renderAll.classList.remove("active");
        break;
      case RenderModes.all:
        this.renderSingle.classList.remove("active");
        this.renderAll.classList.add("active");
        break;
    }

    this.updateRenderMode(newRenderMode);
  }


  /**
    * update render mode
    * @param {RenderModes=} renderMode render mode to update to
    */
  updateRenderMode(renderMode) {
    if (typeof renderMode === "number") this.currentRenderMode = renderMode;

    Array.from(this.pdfContainer.childNodes).forEach((node) => node.remove());
    if (this.currentRenderMode === RenderModes.all) {
      this.#pages.forEach(
        (page) => {
          this.pdfContainer.appendChild(page.pageContainer);
        }
      );
    }

    this.jumpToPage();
  }


  #reset() {
    this.#buffer = new PDFViewBuffer(DEFAULT_CACHE_SIZE);
    this.#pages = [];
    this.filename = null;

    this.currentRenderMode = RenderModes.all;
    this.renderAll.classList.add("active");
    this.renderSingle.classList.remove("active");
  }
};

export { PDFViewer, PDFViewBuffer };
