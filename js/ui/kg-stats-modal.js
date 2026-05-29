/**
 * KG Stats Modal
 * Read-only modal that shows aggregate statistics for the current book's
 * knowledge graph: node/edge counts, in/out-degree distributions, per-chapter
 * coverage shaded by in-degree, connectedness summary, component-size
 * histogram, top-k nodes, and type/Bloom distributions.
 *
 * Mirrors the kg-domain-modal scaffolding (overlay + .modal, Escape/click-out
 * close handlers). All charts are CSS-flex bars — no external chart library.
 */

import {
    IN_DEGREE_BINS,
    COMPONENT_SIZE_BINS,
    NODE_TYPES,
    BLOOM_LEVELS,
    computeDirectedDegrees,
    degreeHistogram,
    perChapterStacked,
    connectedComponents,
    componentSizeHistogram,
    topByDegree,
    typeDistribution,
    bloomDistribution,
    summary
} from '../services/kg-stats.js';

function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function fmtInt(n) {
    return Number.isFinite(n) ? n.toLocaleString() : '0';
}

function fmtDecimal(n, digits = 3) {
    if (!Number.isFinite(n)) return '0';
    return n.toFixed(digits);
}

function chapterLabel(chapters, i) {
    const t = chapters?.[i]?.title;
    return t ? String(t) : `Chapter ${i + 1}`;
}

/**
 * Render a dense degree histogram (one column per integer degree).
 * Empty when nodes are absent.
 */
function renderDegreeHist(rows, ariaLabel) {
    if (rows.length === 0) {
        return `<div class="kg-stats-empty">No data.</div>`;
    }
    const maxCount = rows.reduce((m, r) => Math.max(m, r.count), 0) || 1;
    const bars = rows.map((r) => {
        const heightPct = Math.round((r.count / maxCount) * 100);
        return `
            <div class="kg-stats-bar-col" title="degree ${r.degree}: ${r.count} node${r.count === 1 ? '' : 's'}">
                <div class="kg-stats-bar-stack">
                    <div class="kg-stats-bar kg-stats-bar-plain" style="height: ${heightPct}%"></div>
                </div>
                <div class="kg-stats-bar-label">${r.degree}</div>
            </div>
        `;
    }).join('');
    return `<div class="kg-stats-hist" role="img" aria-label="${esc(ariaLabel)}">${bars}</div>`;
}

/**
 * Render the per-chapter stacked histogram — one column per chapter, each
 * stack split into IN_DEGREE_BINS sub-bins shaded light → dark.
 */
function renderChapterStacked(rows, chapters) {
    if (rows.length === 0) {
        return `<div class="kg-stats-empty">No chapters in this book.</div>`;
    }
    const maxTotal = rows.reduce((m, r) => Math.max(m, r.total), 0) || 1;
    const bars = rows.map((row) => {
        const title = chapterLabel(chapters, row.chapterIndex);
        // High in-degree at top (darkest), low at bottom (lightest) so the
        // "hub" cap reads visually on top of the stack.
        const segs = [];
        for (let i = IN_DEGREE_BINS.length - 1; i >= 0; i--) {
            const c = row.byBin[i];
            segs.push(`<div class="kg-stats-bar-seg kg-stats-bin-${i}" style="flex: ${c}" data-count="${c}"></div>`);
        }
        const heightPct = Math.round((row.total / maxTotal) * 100);
        const breakdown = IN_DEGREE_BINS.map((b, i) => `in-deg ${b.label}: ${row.byBin[i]}`).join(', ');
        const tip = `${title} — ${row.total} node${row.total === 1 ? '' : 's'} (${breakdown})`;
        return `
            <div class="kg-stats-bar-col" title="${esc(tip)}">
                <div class="kg-stats-bar-stack">
                    <div class="kg-stats-bar kg-stats-bar-stacked" style="height: ${heightPct}%">
                        ${segs.join('')}
                    </div>
                </div>
                <div class="kg-stats-bar-label">${row.chapterIndex + 1}</div>
            </div>
        `;
    }).join('');
    const legend = IN_DEGREE_BINS.map((b, i) => `
        <span class="kg-stats-legend-item">
            <span class="kg-stats-legend-swatch kg-stats-bin-${i}"></span>${esc(b.label)}
        </span>
    `).join('');
    return `
        <div class="kg-stats-hist kg-stats-hist-scroll" role="img" aria-label="Nodes per chapter, partitioned by in-degree">
            ${bars}
        </div>
        <div class="kg-stats-legend">In-degree: ${legend}</div>
    `;
}

function renderComponentHist(counts) {
    const maxCount = counts.reduce((m, c) => Math.max(m, c), 0) || 1;
    const bars = COMPONENT_SIZE_BINS.map((b, i) => {
        const heightPct = Math.round((counts[i] / maxCount) * 100);
        return `
            <div class="kg-stats-bar-col" title="size ${b.label}: ${counts[i]} component${counts[i] === 1 ? '' : 's'}">
                <div class="kg-stats-bar-stack">
                    <div class="kg-stats-bar kg-stats-bar-plain" style="height: ${heightPct}%"></div>
                </div>
                <div class="kg-stats-bar-label">${esc(b.label)}</div>
            </div>
        `;
    }).join('');
    return `<div class="kg-stats-hist" role="img" aria-label="Connected-component size distribution">${bars}</div>`;
}

function renderTiles(s) {
    const tiles = [
        ['Nodes', fmtInt(s.nodeCount)],
        ['Edges', fmtInt(s.edgeCount)],
        ['Avg degree', fmtDecimal(s.avgDegree, 2)],
        ['Density', fmtDecimal(s.density, 4)],
        ['Isolated', fmtInt(s.isolatedCount)],
        ['Largest component', fmtInt(s.largestComponentSize)]
    ];
    return `
        <div class="kg-stats-tiles">
            ${tiles.map(([k, v]) => `
                <div class="kg-stats-tile">
                    <div class="kg-stats-tile-value">${esc(v)}</div>
                    <div class="kg-stats-tile-label">${esc(k)}</div>
                </div>
            `).join('')}
        </div>
    `;
}

function renderTopK(items) {
    if (items.length === 0) {
        return `<div class="kg-stats-empty">No nodes to rank.</div>`;
    }
    return `
        <ol class="kg-stats-toplist">
            ${items.map((n) => `
                <li>
                    <span class="kg-stats-toplist-name">${esc(n.canonicalName)}</span>
                    <span class="kg-stats-toplist-degree" title="in ${n.inDegree} / out ${n.outDegree}">${n.degree}</span>
                </li>
            `).join('')}
        </ol>
    `;
}

function renderDistribution(map, keys, ariaLabel) {
    const max = Math.max(1, ...keys.map((k) => map.get(k) ?? 0));
    return `
        <div class="kg-stats-distribution" role="img" aria-label="${esc(ariaLabel)}">
            ${keys.map((k) => {
                const c = map.get(k) ?? 0;
                const widthPct = Math.round((c / max) * 100);
                return `
                    <div class="kg-stats-dist-row">
                        <div class="kg-stats-dist-label">${esc(k)}</div>
                        <div class="kg-stats-dist-track">
                            <div class="kg-stats-dist-fill" style="width: ${widthPct}%"></div>
                        </div>
                        <div class="kg-stats-dist-count">${fmtInt(c)}</div>
                    </div>
                `;
            }).join('')}
        </div>
    `;
}

/**
 * Compute every stat the modal needs from the raw nodes + edges + chapters.
 * Pure function — kept here so the modal renderer can stay focused on DOM.
 */
function computeAll({ nodes, edges, chapters }) {
    const { inDeg, outDeg } = computeDirectedDegrees(edges);
    return {
        summary: summary(nodes, edges, inDeg, outDeg),
        inHist: degreeHistogram(inDeg, nodes),
        outHist: degreeHistogram(outDeg, nodes),
        chapterRows: perChapterStacked(nodes, inDeg, chapters.length),
        componentCounts: componentSizeHistogram(connectedComponents(nodes, edges)),
        top: topByDegree(nodes, inDeg, outDeg, 10),
        types: typeDistribution(nodes),
        blooms: bloomDistribution(nodes)
    };
}

function renderEmptyBody() {
    return `
        <div class="kg-stats-empty-state">
            <p>No knowledge graph data yet. Build the graph for this book first.</p>
        </div>
    `;
}

function renderBody(stats, chapters) {
    return `
        <section class="kg-stats-section">
            ${renderTiles(stats.summary)}
        </section>

        <section class="kg-stats-section">
            <h3>In-degree distribution</h3>
            ${renderDegreeHist(stats.inHist, 'In-degree distribution')}
        </section>

        <section class="kg-stats-section">
            <h3>Out-degree distribution</h3>
            ${renderDegreeHist(stats.outHist, 'Out-degree distribution')}
        </section>

        <section class="kg-stats-section">
            <h3>Nodes per chapter, shaded by in-degree</h3>
            ${renderChapterStacked(stats.chapterRows, chapters)}
        </section>

        <section class="kg-stats-section">
            <h3>Connected component sizes</h3>
            ${renderComponentHist(stats.componentCounts)}
        </section>

        <section class="kg-stats-section kg-stats-section-split">
            <div>
                <h3>Top connected nodes</h3>
                ${renderTopK(stats.top)}
            </div>
            <div>
                <h3>Node types</h3>
                ${renderDistribution(stats.types, NODE_TYPES, 'Node type distribution')}
                <h3 class="kg-stats-subheader">Bloom level</h3>
                ${renderDistribution(stats.blooms, BLOOM_LEVELS, 'Bloom level distribution')}
            </div>
        </section>
    `;
}

/**
 * Open the stats modal. Resolves once the modal is closed.
 *
 * @param {Object} args
 * @param {Array} args.nodes
 * @param {Array} args.edges
 * @param {Array<{ title?: string }>} args.chapters
 * @returns {Promise<void>}
 */
export function openKGStatsModal({ nodes, edges, chapters }) {
    const safeNodes = Array.isArray(nodes) ? nodes : [];
    const safeEdges = Array.isArray(edges) ? edges : [];
    const safeChapters = Array.isArray(chapters) ? chapters : [];
    const hasData = safeNodes.length > 0;
    const stats = hasData
        ? computeAll({ nodes: safeNodes, edges: safeEdges, chapters: safeChapters })
        : null;

    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay active kg-stats-modal-overlay';
        overlay.innerHTML = `
            <div class="modal kg-stats-modal" role="dialog" aria-modal="true" aria-label="Knowledge graph statistics">
                <div class="modal-header">
                    <h2>Knowledge graph statistics</h2>
                    <button type="button" class="btn-icon kg-stats-close-btn" aria-label="Close">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
                <div class="modal-content kg-stats-content">
                    ${hasData ? renderBody(stats, safeChapters) : renderEmptyBody()}
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-primary" data-action="close">Close</button>
                </div>
            </div>
        `;
        document.body.appendChild(overlay);

        let done = false;
        const finish = () => {
            if (done) return;
            done = true;
            document.removeEventListener('keydown', onKey);
            overlay.remove();
            resolve();
        };
        const onKey = (e) => { if (e.key === 'Escape') finish(); };

        overlay.querySelector('.kg-stats-close-btn').addEventListener('click', finish);
        overlay.querySelector('[data-action="close"]').addEventListener('click', finish);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) finish();
        });
        document.addEventListener('keydown', onKey);
    });
}
