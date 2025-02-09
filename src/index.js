import { App } from './app'
import { html } from './components/utils'
import pdfViewer from './components/viewer';


const mainContainer = html`
  <div id="main-container">
    <input
      id="upload"
      type="file"
      accept="application/pdf"
    />
    <div class="appbar">
      <button
        data-modal-target="#pdf-viewer"
        id="uploadBtn"
        value="Browse..."
        onclick="document.getElementById('upload').click()"
      >
        <span id="uploadBtnText">
          +
        </span>
      </button>
    </div>
    <div id="dashboard">
    </div>
  </div>
`;

App.run(mainContainer, pdfViewer);
