// ===============================
// SIDE PANEL SEARCH (OPTION 1)
// ===============================

// TEMP: mock search backend (replace later with real API)
async function mockSearch(query) {
  return [
    {
      title: "Artificial Intelligence - Wikipedia",
      snippet:
        "Artificial intelligence (AI) refers to the simulation of human intelligence in machines.",
      url: "https://en.wikipedia.org/wiki/Artificial_intelligence",
      source: "Wikipedia"
    },
    {
      title: "What is AI? - IBM",
      snippet:
        "AI enables computers to perform tasks that normally require human intelligence.",
      url: "https://www.ibm.com/topics/artificial-intelligence",
      source: "IBM"
    },
    {
      title: "MIT Introduction to AI",
      snippet:
        "An overview of artificial intelligence concepts and applications.",
      url: "https://news.mit.edu/topic/artificial-intelligence2",
      source: "MIT"
    }
  ];
}

// ===============================
// SIDE VIEW CONTROLLER
// ===============================

function openSidePanel() {
  document.getElementById("side-pane").hidden = false;
}

function renderSearchResults(query, results) {
  const sidePane = document.getElementById("side-pane");

  sidePane.innerHTML = `
    <div style="padding:16px; font-family:system-ui; color:#eaeaea;">
      <h3 style="margin-top:0;">🔍 Results for “${query}”</h3>

      ${results
        .map(
          (r, i) => `
          <div style="margin-bottom:14px;">
            <div style="font-weight:600;">${i + 1}. ${r.title}</div>
            <div style="font-size:0.9em; opacity:0.85;">${r.snippet}</div>
            <div style="margin-top:4px;">
              <a href="${r.url}" target="_blank" style="color:#6aa6ff;">
                Open source →
              </a>
              <span style="opacity:0.6; margin-left:6px;">(${r.source})</span>
            </div>
          </div>
        `
        )
        .join("")}
    </div>
  `;
}

// ===============================
// MAIN ENTRY (VERA CALLS THIS)
// ===============================

export async function openSideSearch(action) {
  const sidePane = document.getElementById("side-pane");
  if (!sidePane) return;

  openSidePanel();

  // loading state
  sidePane.innerHTML = `
    <div style="padding:16px; color:#aaa;">
      Searching for “${action.query}”…
    </div>
  `;

  // TEMP: replace with real search later
  const results = await mockSearch(action.query);

  renderSearchResults(action.query, results);
}
