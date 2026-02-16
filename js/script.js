// --- SETUP INIZIALE ---
const svg = d3.select("#graph");
let width = document.getElementById("graph-container").clientWidth;
let height = document.getElementById("graph-container").clientHeight;
let simulation = null;

const tooltip = d3.select("#tooltip");

let interactive = false;
let isDrawingMode = false; // Global state for drawing mode
let currentDepthLevel = 3; // Start at max depth (bottom 3 step filter)
let revealedNodes = new Set(); // Track manually expanded nodes
let authorMap = new Map(); // To cache author details
let tutorialSteps = [];
let updateMinimapViewport = null; // Funzione placeholder per aggiornare la minimappa
let updateSimulationCenter = null; // Funzione placeholder per centrare la simulazione

// Group wrapper for zoom/pan
const g = svg.append("g");

// Drawing Order: Hulls -> Links -> Nodes -> Labels
const hullGroup = g.append("g").attr("class", "hulls");
const linkGroup = g.append("g").attr("class", "links");
const postitLinkGroup = g.append("g").attr("class", "postit-links"); // Layer for post-it connections
const nodeGroup = g.append("g").attr("class", "nodes");
const labelGroup = g.append("g").attr("class", "labels");
const postitGroup = g.append("g").attr("class", "postits"); // Layer for post-its
const drawingGroup = g.append("g").attr("class", "drawings").lower(); // Layer for drawings (below nodes/postits)

const zoom = d3.zoom()
    .scaleExtent([0.1, 4])
    .translateExtent([[-width, -height], [width * 2, height * 2]])
    .on("zoom", (event) => {
        // Blocca solo se non è interattivo E l'evento è generato dall'utente (mouse/touch).
        // Se event.sourceEvent è null, è uno zoom programmatico (tutorial) e deve passare.
        if (!interactive && event.sourceEvent) return;
        g.attr("transform", event.transform);
        if (updateMinimapViewport) updateMinimapViewport(event.transform);
    });

// Apply zoom filter to disable panning when drawing
zoom.filter((event) => {
    // If drawing mode is active and event is mousedown/touchstart, ignore zoom (allow drawing)
    if (typeof isDrawingMode !== 'undefined' && isDrawingMode && (event.type === 'mousedown' || event.type === 'touchstart')) return false;
    
    // Allow wheel events even with Ctrl key (fixes pinch-to-zoom on trackpads), block secondary buttons
    return (!event.button && (event.type === 'wheel' || !event.ctrlKey));
});

svg.call(zoom);

function alignLayout() {
    const minimap = document.getElementById("minimap-container");
    const btnIds = [
        "reset-view-container",
        "zoom-out-container",
        "zoom-in-container",
        "export-view-container",
        "theme-toggle-container"
    ];
    
    const buttons = btnIds.map(id => document.getElementById(id)).filter(el => el);
    if (!minimap) return;

    // Usiamo getComputedStyle per ottenere i valori di layout "target" definiti nel CSS.
    // Questo ignora le trasformazioni temporanee (come il translateY di nav-hidden) e rispetta i margini reali.
    const mStyle = window.getComputedStyle(minimap);
    const mHeight = parseFloat(mStyle.height) || 0;
    const mBottom = parseFloat(mStyle.bottom) || 0; 
    
    // Read gap dynamically from CSS variable to ensure consistency
    const rootStyle = getComputedStyle(document.documentElement);
    const gap = parseFloat(rootStyle.getPropertyValue('--panel-gap')) || 10;

    // 1. Align Left Stack (Minimap -> Suggested -> Notes)
    const suggested = document.getElementById("suggested-views-container");
    const notes = document.getElementById("personal-notes-container");
    
    let currentBottom = mBottom + mHeight + gap;

    if (suggested && !suggested.classList.contains('nav-hidden')) {
        suggested.style.bottom = `${currentBottom}px`;
        currentBottom += suggested.offsetHeight + gap;
    }

    if (notes && !notes.classList.contains('nav-hidden')) {
        notes.style.bottom = `${currentBottom}px`;
    }
    
    // 2. Align Side Buttons (Right of Minimap)
    if (buttons.length < 2) return;

    const stackButtons = buttons;
    
    const mWidth = parseFloat(mStyle.width) || 0;
    const mLeft = parseFloat(mStyle.left) || 0;
    const sideLeft = mLeft + mWidth + gap;

    const btnHeight = stackButtons[0].offsetHeight || 36; 
    const numButtons = stackButtons.length;

    stackButtons.forEach((btn, i) => {
        let posBottom;
        if (numButtons <= 1) {
            posBottom = mBottom + (mHeight - btnHeight) / 2;
        } else {
            // Distribute buttons exactly within the minimap's height
            posBottom = mBottom + (i * (mHeight - btnHeight) / (numButtons - 1));
        }
        btn.style.bottom = `${posBottom}px`;
        btn.style.left = `${sideLeft}px`;
    });

    // 3. Align Drawing Color Palette (Right of Personal Notes)
    const palette = document.getElementById("drawing-color-palette");
    if (palette && notes) {
        // Align bottom with personal notes
        palette.style.bottom = notes.style.bottom;

        // Sync height with personal notes
        palette.style.height = `${notes.offsetHeight}px`;
        
        // Align left: Minimap Left + Minimap Width + Gap
        const mWidth = parseFloat(mStyle.width) || 0;
        const mLeft = parseFloat(mStyle.left) || 0;
        
        palette.style.left = `${mLeft + mWidth + gap}px`;
    }
}

// Observer to handle layout changes when minimap or panels resize (e.g. via CSS or content)
const layoutObserver = new ResizeObserver(() => {
    alignLayout();
});

window.addEventListener("resize", () => {
    const container = document.getElementById("graph-container");
    if (!container) return;

    width = container.clientWidth;
    height = container.clientHeight;
    zoom.translateExtent([[-width, -height], [width * 2, height * 2]]);

    // Controllo di sicurezza: esegui solo se la simulazione è già stata inizializzata
    if (simulation && updateSimulationCenter) {
        const tutorialSidebar = document.getElementById("tutorial-sidebar");
        const tutorialOpen = tutorialSidebar && !tutorialSidebar.classList.contains('tutorial-closed');
        updateSimulationCenter(tutorialOpen);
    }
    alignLayout();
});

// Initialize observers once the DOM is ready
document.addEventListener("DOMContentLoaded", () => {
    const minimap = document.getElementById("minimap-container");
    if (minimap) layoutObserver.observe(minimap);
    const suggested = document.getElementById("suggested-views-container");
    if (suggested) layoutObserver.observe(suggested);
});

function hexToRgba(hex, alpha) {
    hex = hex.replace("#", "");
    const r = parseInt(hex.substring(0, 2), 16);
    const g = parseInt(hex.substring(2, 4), 16);
    const b = parseInt(hex.substring(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

// --- GLOBAL REFERENCES ---
let globalNodes = [];
let globalEdges = [];
let postitLinksData = []; // Store connections between post-its and nodes
let titleAccessorGlobal;
let globalClusterMembers = new Map();
let getLinkOpacity; // Global helper for consistency
// --- TIMELINE VARIABLES (GLOBAL) ---
let timeDomain = [0, 0];
let currentTime = 0;
let isPlaying = false;
let playInterval;
let animationDuration = 10000; // Default, will be recalculated based on data
let isTimelineUpdate = false;

// Placeholder per updateGraphDepth (verrà sovrascritta dopo il caricamento dati)
window.updateGraphDepth = function() {};

let selectedNodeData = null;
let selectionRing;

let activeHighlightFilter = null;

// --- HIGHLIGHT FUNCTIONS ---
function highlightNodes(filterFn) {
    activeHighlightFilter = filterFn;
    // 1. Update NODI
    // Selezioniamo solo i path con classe .node, escludendo l'anello di selezione
    nodeGroup.selectAll("path.node").transition().duration(400)
        .attr("opacity", d => titleAccessorGlobal(d) === "CLUSTER" ? 0 : 1) // Ensure base opacity is 1
        .attr("fill-opacity", d => (filterFn(d) ? 1 : 0.15))
        .attr("stroke-opacity", d => (filterFn(d) ? 1 : 0.1));

    // 2. Update LINK (La logica richiesta)
    linkGroup.selectAll("line").transition().duration(400)
        .attr("stroke-opacity", d => {
            // Un link è attivo SOLO SE entrambi i nodi che connette sono attivi
            const isSourceActive = filterFn(d.source);
            const isTargetActive = filterFn(d.target);

            if (isSourceActive && isTargetActive) {
                return getLinkOpacity(d, true); // Active state
            }

            // Se uno dei due nodi è disattivo, il link quasi scompare
            return 0.02;
        });

    // 3. Update ETICHETTE
    labelGroup.selectAll("text").transition().duration(400)
        .attr("opacity", d => (filterFn(d) ? 1 : 0.1));

    // 4. Update HULLS (Aree Cluster)
    hullGroup.selectAll("path").transition().duration(400)
        .attr("fill-opacity", d => (filterFn(d) ? 0.5 : 0.1))
        .attr("stroke-opacity", d => (filterFn(d) ? 1.0 : 0.2));
}

function resetHighlight() {
    activeHighlightFilter = null;
    nodeGroup.selectAll("path.node").transition().duration(400)
        .attr("opacity", d => titleAccessorGlobal(d) === "CLUSTER" ? 0 : 1) // Reset base opacity
        .attr("fill-opacity", 1)
        .attr("stroke-opacity", 1);

    linkGroup.selectAll("line").transition().duration(400)
        .attr("stroke-opacity", d => getLinkOpacity(d));

    labelGroup.selectAll("text").transition().duration(400)
        .attr("opacity", 1);

    hullGroup.selectAll("path").transition().duration(400)
        .attr("fill-opacity", 0.25)
        .attr("stroke-opacity", 0.75);
}

Promise.all([
    d3.csv("data/KG_nodes.csv"),
    d3.csv("data/KG_edges.csv"),
    d3.json("data/authors.json").catch(err => {
        console.warn("File authors.json not found", err);
        return [];
    }),
    d3.json("data/tutorial.json").catch(err => {
        console.error("Errore caricamento tutorial.json:", err);
        return [];
    })
]).then(([nodes, edges, authorsData, tutorialData]) => {

    // Inizializza l'anello di selezione
    selectionRing = nodeGroup.append("path").attr("class", "selection-ring").style("opacity", 0);

    if (Array.isArray(tutorialData) && tutorialData.length > 0) {
        tutorialSteps = tutorialData;
    } else {
        console.warn("Tutorial data vuoto o non valido.");
    }

    titleAccessorGlobal = d => d.title || d.detail__title || "Untitled";
    const titleAccessor = titleAccessorGlobal;

    // --- Creazione Mappa Autori ---
    // Usiamo la variabile globale authorMap definita sopra
    if (Array.isArray(authorsData)) {
        authorsData.forEach(user => {
            // Mappa ID -> Nome
            // Le API BCause usano solitamente 'name' o 'nickname'
            const cleanId = String(user.id).replace(/['"]+/g, '').trim();
            const name = user.pseudo || "Anonymous";
            authorMap.set(cleanId, name);
        });
    }
    // -----------------------------

    // --- TIMELINE LOGIC: Mappatura Timestamp ---
    // (timeDomain, currentTime, isPlaying, playInterval, animationDuration già definiti come globali)
    const nodeTimeMap = new Map(); // ID Autore -> Timestamp

    if (Array.isArray(authorsData)) {
        authorsData.forEach(item => {
            // Mappa Timestamp usando ID dell'autore (item.id)
            if (item.id && item.creation_timestamp) {
                nodeTimeMap.set(item.id, item.creation_timestamp);
            }
        });
    }

    // Assegna timestamp ai nodi usando detail__author_id
    let minTs = Infinity;
    let maxTs = -Infinity;

    nodes.slice(0, 5).forEach(n => {
        let cleanAuthorId = n.detail__author_id ? n.detail__author_id.replace(/"/g, '') : null;
        console.log(`  Nodo ${n.id}: detail__author_id="${cleanAuthorId}", hasTimestamp=${nodeTimeMap.has(cleanAuthorId)}`);
    });

    nodes.forEach(n => {
        // Usa detail__author_id (colonna che contiene l'ID autore del contributo)
        // Rimuovi le virgolette extra dal CSV
        let authorId = n.detail__author_id ? n.detail__author_id.replace(/"/g, '') : null;

        if (authorId && nodeTimeMap.has(authorId)) {
            n.timestamp = nodeTimeMap.get(authorId);
        } else {
            n.timestamp = null; // Da calcolare dopo (propagazione)
        }
    });

    // Propagazione date: Un nodo senza data nasce quando nasce il suo primo vicino
    // Eseguiamo 3 iterazioni per propagare attraverso la rete
    for (let i = 0; i < 3; i++) {
        nodes.forEach(n => {
            if (n.timestamp) return; // Salta se ha già data

            // Trova vicini tramite edges
            const neighborIds = new Set();
            edges.forEach(e => {
                if (e.source === n.id) neighborIds.add(e.target);
                if (e.target === n.id) neighborIds.add(e.source);
            });

            // Trova data minima tra i vicini
            let earliest = Infinity;
            nodes.forEach(neighbor => {
                if (neighborIds.has(neighbor.id) && neighbor.timestamp) {
                    if (neighbor.timestamp < earliest) earliest = neighbor.timestamp;
                }
            });

            if (earliest !== Infinity) n.timestamp = earliest;
        });
    }

    // Fix temporale: Assicura che gli argomenti non compaiano prima delle posizioni
    // Deve avvenire PRIMA del calcolo del dominio temporale
    const tempNodeMap = new Map(nodes.map(n => [n.id, n]));
    for (let i = 0; i < 3; i++) {
        edges.forEach(e => {
            const s = tempNodeMap.get(e.source);
            const t = tempNodeMap.get(e.target);
            if (!s || !t || !s.timestamp || !t.timestamp) return;

            const sType = titleAccessorGlobal(s);
            const tType = titleAccessorGlobal(t);

            // 1. Position -> Argument
            if (sType === "POSITION" && (tType === "INFAVOR" || tType === "AGAINST")) {
                if (t.timestamp < s.timestamp) t.timestamp = s.timestamp;
            } else if (tType === "POSITION" && (sType === "INFAVOR" || sType === "AGAINST")) {
                if (s.timestamp < t.timestamp) s.timestamp = t.timestamp;
            }

            // 2. Parent -> Entity (Keyword)
            // Keywords shouldn't appear before the node that generated them
            if (sType !== "ENTITY" && tType === "ENTITY") {
                if (t.timestamp < s.timestamp) t.timestamp = s.timestamp;
            } else if (tType !== "ENTITY" && sType === "ENTITY") {
                if (s.timestamp < t.timestamp) s.timestamp = t.timestamp;
            }
        });
    }

    // Calcola dominio temporale
    nodes.filter(n => n.timestamp).forEach(n => {
        if (n.timestamp < minTs) minTs = n.timestamp;
        if (n.timestamp > maxTs) maxTs = n.timestamp;
    });

    // Fix finale: assegna minTs a chi è rimasto senza data
    nodes.forEach(n => {
        if (!n.timestamp) n.timestamp = minTs === Infinity ? 0 : minTs;
    });

    // Imposta dominio e tempo iniziale
    timeDomain = [minTs === Infinity ? 0 : minTs, maxTs === -Infinity ? 0 : maxTs];
    currentTime = timeDomain[1]; // Inizia alla fine (tutto visibile)

    // --- CALCOLO DURATA PROPORZIONALE ---
    // 1 giorno di dibattito = 1 secondo di animazione (1000ms)
    const MS_PER_DAY = 24 * 60 * 60 * 1000;
    const debateDays = (timeDomain[1] - timeDomain[0]) / MS_PER_DAY;
    animationDuration = Math.min(90000, Math.max(5000, debateDays * 1000));

    globalNodes = nodes;
    globalEdges = edges;

    const uniqueEdgesMap = new Map();
    edges.forEach(e => {
        const key = `${e.source}-${e.target}-${e.mainStat}`;
        if (!uniqueEdgesMap.has(key)) {
            uniqueEdgesMap.set(key, e);
        }
    });
    const cleanedEdges = Array.from(uniqueEdgesMap.values());

    // Aggiorna riferimento globale
    globalEdges = cleanedEdges;

    // --- Network Palette (Linked to CSS Variables) ---
    const rootStyle = getComputedStyle(document.documentElement);
    const getCV = (name) => rootStyle.getPropertyValue(name).trim();

    const colorMap = {
        "SUBJECT":  getCV('--color-subject')  || "#3f88c5",
        "POSITION": getCV('--color-position') || "#F49D37",
        "INFAVOR":  getCV('--color-infavor')  || "#00cc66",
        "AGAINST":  getCV('--color-against')  || "#db3a34",
        "ENTITY":   getCV('--color-keyword')  || "#321325",
        "default":  "#7f7f7f"
    };

    const clusterFillColor = "#d0e0f5"; // Grigio chiaro azzurrato (più saturo)
    const clusterStrokeColor = "#7b91b3"; // Bordo più scuro coordinato (più saturo)

    function getClusterColor(d) {
        const members = globalClusterMembers.get(d.id) || [];
        let inFavor = 0;
        let against = 0;

        members.forEach(m => {
            const type = titleAccessorGlobal(m);
            if (type === "INFAVOR") inFavor++;
            if (type === "AGAINST") against++;
        });

        if (inFavor > against) {
            return { fill: "#c8f7d8", stroke: "#6ee7b7" }; // Verde tenue (più saturo)
        } else if (against > inFavor) {
            return { fill: "#fecaca", stroke: "#fb7185" }; // Rosso tenue (più saturo)
        }
        return { fill: clusterFillColor, stroke: clusterStrokeColor }; // Bilanciato (più saturo)
    }

    function getNodeColorByType(type) {
        return colorMap[type] || colorMap["default"];
    }

    function getNodeColor(d) {
        return getNodeColorByType(titleAccessor(d));
    }

    function getShapeByType(type) {
        return type === "ENTITY" ? "diamond" : "circle";
    }

    const nodeById = new Map(nodes.map(d => [d.id, d]));
    edges = edges.filter(e => nodeById.has(e.source) && nodeById.has(e.target));

    // Helper per la coerenza visiva degli archi (Unifica spessore e stile)
    const getLinkStrokeWidth = d => {
        const sType = titleAccessorGlobal(nodeById.get(d.source.id || d.source));
        const tType = titleAccessorGlobal(nodeById.get(d.target.id || d.target));
        return (sType === "ENTITY" || tType === "ENTITY") ? 1.5 : 1.8;
    };

    const getLinkDashArray = d => {
        const sType = titleAccessorGlobal(nodeById.get(d.source.id || d.source));
        const tType = titleAccessorGlobal(nodeById.get(d.target.id || d.target));
        return (sType === "ENTITY" || tType === "ENTITY") ? "4,8" : "none";
    };

    getLinkOpacity = (d, active = false) => {
        const sType = titleAccessorGlobal(nodeById.get(d.source.id || d.source));
        const tType = titleAccessorGlobal(nodeById.get(d.target.id || d.target));
        const isEntity = (sType === "ENTITY" || tType === "ENTITY");
        if (active) return isEntity ? 0.4 : 0.8; // active opacity controller
        return isEntity ? 0.35 : 0.6; // default opacity controlloer (dashed vs solid)
    };

    // --- CLUSTER LOGIC ---
    const clusterMembers = new Map();

    nodes.forEach(n => {
        if (titleAccessor(n) === "CLUSTER") {
            clusterMembers.set(n.id, [n]);
        }
    });

    edges.forEach(e => {
        const s = nodeById.get(e.source);
        const t = nodeById.get(e.target);
        const sType = titleAccessor(s);
        const tType = titleAccessor(t);

        if (sType === "CLUSTER") {
            if (clusterMembers.has(s.id)) clusterMembers.get(s.id).push(t);
        }
        if (tType === "CLUSTER") {
            if (clusterMembers.has(t.id)) clusterMembers.get(t.id).push(s);
        }
    });

    globalClusterMembers = clusterMembers;

    const structuralDegree = new Map(); // Solo connessioni tra contributi umani
    const conceptualDegree = new Map(); // Connessioni verso le keyword

    nodes.forEach(n => {
        structuralDegree.set(n.id, 0);
        conceptualDegree.set(n.id, 0);
    });

    cleanedEdges.forEach(e => {
        const s = nodeById.get(e.source);
        const t = nodeById.get(e.target);
        const sType = titleAccessorGlobal(s);
        const tType = titleAccessorGlobal(t);

        // Se nessuno dei due è una Keyword, è un legame strutturale (umano)
        if (sType !== "ENTITY" && tType !== "ENTITY") {
            structuralDegree.set(e.source, structuralDegree.get(e.source) + 1);
            structuralDegree.set(e.target, structuralDegree.get(e.target) + 1);
        } else {
            // Altrimenti è un legame concettuale
            conceptualDegree.set(e.source, conceptualDegree.get(e.source) + 1);
            conceptualDegree.set(e.target, conceptualDegree.get(e.target) + 1);
        }
    });

    const nodeToClusterMap = new Map();
globalClusterMembers.forEach((members, clusterId) => {
    members.forEach(m => {
        if (titleAccessorGlobal(m) !== "CLUSTER") {
            nodeToClusterMap.set(m.id, clusterId);
        }
    });
});

    nodes.forEach(n => {
        const type = titleAccessorGlobal(n);
        if (type === "ENTITY") {
            // Le keyword si basano sul loro grado concettuale
            n.degree = conceptualDegree.get(n.id);
        } else {
            // I contributi umani ignorano le keyword per la loro dimensione
            n.degree = structuralDegree.get(n.id);
        }
    });

    // Scale diverse per pesi diversi
    const sizeScale = d3.scaleLinear()
        .domain([0, d3.max(nodes.filter(n => titleAccessorGlobal(n) !== "ENTITY"), d => d.degree)])
        .range([12, 45]); // Nodi umani: da 12 a 45px

    const keywordScale = d3.scaleLinear()
        .domain([0, d3.max(nodes.filter(n => titleAccessorGlobal(n) === "ENTITY"), d => d.degree)])
        .range([2, 8]);  // Keyword: molto più piccole e discrete (6-12px)

    function getNodeVisualRadius(d) {
        const type = titleAccessorGlobal(d);
        if (type === "ENTITY") return keywordScale(d.degree || 0);
        if (type === "SUBJECT") return 50; // Il soggetto è sempre il più grande

        if (type === "POSITION") {
            // Enfatizza la dimensione dei nodi POSITION in base alle connessioni
            // Base 16px + 3.5px per ogni connessione, max 48px
            const deg = d.degree || 0;
            return Math.min(8 + (deg * 3.5), 48);
        }

        return sizeScale(d.degree || 0);
    }

    // --- EVENT HANDLERS DEFINITIONS ---
    function handleNodeMouseOver(event, d) {
        tooltip.style("opacity", 1).html(buildTooltipHTML(d));
        moveTooltip(event);

        if (titleAccessorGlobal(d) === "ENTITY" && d.detail__value && !d._open) {
            const nodeSel = d3.select(event.currentTarget);
            nodeSel.attr("opacity", 0);

            const hoverLabel = labelGroup.append("text")
                .datum(d)
                .attr("class", "entity-hover-label")
                .attr("text-anchor", "middle")
                .attr("alignment-baseline", "middle")
                .style("font-size", "var(--fs-tiny)")
                .style("font-weight", "500")
                .style("pointer-events", "none")
                .text(truncate(d.detail__value, 24));

            hoverLabel
                .attr("x", d.x)
                .attr("y", d.y);
        }
    }

    function handleNodeMouseMove(event) {
        moveTooltip(event);
    }

    function handleNodeMouseOut(event, d) {
        tooltip.style("opacity", 0);

        if (titleAccessorGlobal(d) === "ENTITY" && d.detail__value) {
            const nodeSel = d3.select(event.currentTarget);
            nodeSel.attr("opacity", 1);
            labelGroup.selectAll(".entity-hover-label")
                .filter(l => l.id === d.id)
                .remove();
        }
    }

    function handleNodeClick(event, d) {
        if (!interactive) return;
        event.stopPropagation();

        // Gestione selezione visiva (Highlight click)
        nodeGroup.selectAll(".node").classed("selected", false);
        d3.select(event.currentTarget).classed("selected", true).raise();

        // Gestione Anello Tecnico
        selectedNodeData = d;
        
        const shapeType = getShapeByType(titleAccessorGlobal(d));
        const ringRadius = getNodeVisualRadius(d) + 6; // Leggermente più grande del nodo
        const ringSize = Math.PI * Math.pow(ringRadius, 2);
        const symbolType = (shapeType === "diamond") ? d3.symbolDiamond : d3.symbolCircle;

        selectionRing.attr("d", d3.symbol().type(symbolType).size(ringSize)())
            .style("opacity", 1).attr("transform", `translate(${d.x},${d.y})`).raise();

        resetEntitiesVisuals();
        showNodeDetails(d);

        let isOpening = true;

        // --- LOGICA TOGGLE / DRILL-DOWN ---
        if (currentDepthLevel < 3) {
            const type = titleAccessorGlobal(d);
            let directChildren = [];
            let subChildren = [];

            if (currentDepthLevel === 1 && type === 'POSITION') {
                directChildren = globalEdges.filter(e => (e.source.id || e.source) === d.id || (e.target.id || e.target) === d.id)
                    .map(e => (e.source.id || e.source) === d.id ? e.target : e.source)
                    .filter(n => {
                        const t = titleAccessorGlobal(n);
                        return t === 'INFAVOR' || t === 'AGAINST';
                    });

                directChildren.forEach(arg => {
                    const entities = globalEdges.filter(e => (e.source.id || e.source) === arg.id || (e.target.id || e.target) === arg.id)
                        .map(e => (e.source.id || e.source) === arg.id ? e.target : e.source)
                        .filter(n => titleAccessorGlobal(n) === 'ENTITY');
                    subChildren.push(...entities);
                });
            }

            else if ((currentDepthLevel < 3) && (type === 'INFAVOR' || type === 'AGAINST')) {
                directChildren = globalEdges.filter(e => (e.source.id || e.source) === d.id || (e.target.id || e.target) === d.id)
                    .map(e => (e.source.id || e.source) === d.id ? e.target : e.source)
                    .filter(n => titleAccessorGlobal(n) === 'ENTITY');
            }

            if (directChildren.length > 0) {
                const isBranchOpen = directChildren.some(child => revealedNodes.has(child.id));

                if (isBranchOpen) {
                    isOpening = false;
                    directChildren.forEach(n => revealedNodes.delete(n.id));
                    subChildren.forEach(n => revealedNodes.delete(n.id));
                } else {
                    isOpening = true;
                    directChildren.forEach(n => revealedNodes.add(n.id));
                }

                updateGraphDepth(currentDepthLevel, true);
            }
        }

        const t = titleAccessorGlobal(d);
        if ((t === "INFAVOR" || t === "AGAINST") && isOpening) {
            showConnectedEntitiesText(d);
        }

        highlightNodes(n =>
            n.id === d.id ||
            globalEdges.some(e => ((e.source.id || e.source) === d.id && (e.target.id || e.target) === n.id) || ((e.target.id || e.target) === d.id && (e.source.id || e.source) === n.id))
        );
    }

    function handleHullClick(event, d) {
        if (!interactive) return;
        event.stopPropagation();
        resetEntitiesVisuals();
        showNodeDetails(d);

        const members = globalClusterMembers.get(d.id) || [];
        const memberIds = new Set(members.map(m => m.id));
        highlightNodes(n => memberIds.has(n.id));
    }

    function handleHullMouseOver(event, d) {
        tooltip.style("opacity", 1).html(`<strong>CLUSTER</strong><br/>${d.detail__tagline || ""}`);
        moveTooltip(event);

        const currentOpacity = parseFloat(d3.select(this).attr("fill-opacity"));
        if (currentOpacity > 0.05) {
            d3.select(this)
                .attr("fill-opacity", 0.5) // Aumentata opacità hover
                .attr("stroke-opacity", 1.0); // Aumentata opacità hover
        }
    }

    function handleHullMouseMove(event) {
        moveTooltip(event);
    }

    function handleHullMouseOut() {
        tooltip.style("opacity", 0);
        const currentOpacity = parseFloat(d3.select(this).attr("fill-opacity"));
        if (currentOpacity > 0.05) {
            d3.select(this)
                .attr("fill-opacity", 0.35) // Ripristinata opacità normale
                .attr("stroke-opacity", 0.85); // Ripristinata opacità normale
        }
    }

    // --- 1. DRAW HULLS ---
    const hullPadding = 20;
    const curve = d3.line().curve(d3.curveBasisClosed);

    function getHullPoints(clusterNode) {
        const allMembers = clusterMembers.get(clusterNode.id) || [];
        const visibleMembers = allMembers.filter(m => titleAccessor(m) !== "CLUSTER");

        if (visibleMembers.length === 0) return [];

        const points = [];
        visibleMembers.forEach(m => {
            if (!m.x || !m.y) return;
            const r = getNodeVisualRadius(m) + hullPadding;
            points.push([m.x - r, m.y]);
            points.push([m.x + r, m.y]);
            points.push([m.x, m.y - r]);
            points.push([m.x, m.y + r]);
        });

        return d3.polygonHull(points) || [];
    }

    function getHullPath(clusterNode) {
        const hullPoints = getHullPoints(clusterNode);
        return hullPoints.length ? curve(hullPoints) : "";
    }

    // Helper per calcolare intersezione linea-poligono (per link post-it -> cluster)
    function getLineIntersection(p1, p2, p3, p4) {
        const x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
        const x3 = p3[0], y3 = p3[1], x4 = p4[0], y4 = p4[1];
        const denom = (y4 - y3) * (x2 - x1) - (x4 - x3) * (y2 - y1);
        if (denom === 0) return null;
        const ua = ((x4 - x3) * (y1 - y3) - (y4 - y3) * (x1 - x3)) / denom;
        const ub = ((x2 - x1) * (y1 - y3) - (y2 - y1) * (x1 - x3)) / denom;
        if (ua >= 0 && ua <= 1 && ub >= 0 && ub <= 1) return [x1 + ua * (x2 - x1), y1 + ua * (y2 - y1)];
        return null;
    }

    function getPolygonIntersection(p1, p2, polygon) {
        let bestIntersect = null;
        let minDist = Infinity;
        for (let i = 0; i < polygon.length; i++) {
            const intersect = getLineIntersection(p1, p2, polygon[i], polygon[(i + 1) % polygon.length]);
            if (intersect) {
                const dist = (intersect[0] - p1[0]) ** 2 + (intersect[1] - p1[1]) ** 2;
                if (dist < minDist) { minDist = dist; bestIntersect = intersect; }
            }
        }
        return bestIntersect;
    }

    const hullData = nodes.filter(d => titleAccessor(d) === "CLUSTER");
    let hulls = hullGroup.selectAll("path")
        .data(hullData)
        .enter()
        .append("path")
        .attr("class", "hull")
        .attr("fill", d => getClusterColor(d).fill)
        .attr("stroke", d => getClusterColor(d).stroke)
        .attr("fill-opacity", 0.35) // Aumentata opacità
        .attr("stroke-opacity", 0.85) // Aumentata opacità
        .on("click", handleHullClick)
        .on("mouseover", handleHullMouseOver)
        .on("mousemove", handleHullMouseMove)
        .on("mouseout", handleHullMouseOut);


    // --- 2. DRAW LINKS ---
    const visualEdges = cleanedEdges.filter(e => {
        const sType = titleAccessor(nodeById.get(e.source));
        const tType = titleAccessor(nodeById.get(e.target));
        return sType !== "CLUSTER" && tType !== "CLUSTER";
    });

    // --- DISEGNO DEI LINK CON DIFFERENZIAZIONE SEMANTICA ---
    let link = linkGroup.selectAll("line")
        .data(visualEdges)
        .enter()
        .append("line")
        .attr("class", "link")
        // Colore base dei link
        .attr("stroke", "#000000")
        // Spessore differenziato
        .attr("stroke-width", d => getLinkStrokeWidth(d))
        // TRATTEGGIO: Solo per le Keywords (ENTITY)
        .style("stroke-dasharray", d => getLinkDashArray(d))
        // Opacità ridotta per le connessioni AI
        .attr("stroke-opacity", d => getLinkOpacity(d));

    // --- 3. DRAW NODES ---
    let node = nodeGroup.selectAll("path.node")
        .data(nodes)
        .enter()
        .append("path")
        .attr("class", "node")
        .attr("d", d => {
            const shapeType = getShapeByType(titleAccessor(d));
            const radius = getNodeVisualRadius(d);
            const size = Math.PI * Math.pow(radius, 2);
            const symbolType = (shapeType === "diamond") ? d3.symbolDiamond : d3.symbolCircle;
            return d3.symbol().type(symbolType).size(size)();
        })
        .attr("fill", d => getNodeColor(d))
        .attr("stroke", d => hexToRgba(getNodeColor(d), 0.45))
        .attr("stroke-width", 2)
        .attr("opacity", d => titleAccessor(d) === "CLUSTER" ? 0 : 1)
        .style("pointer-events", d => titleAccessor(d) === "CLUSTER" ? "none" : "all")
        .on("mouseover", handleNodeMouseOver)
        .on("mousemove", handleNodeMouseMove)
        .on("mouseout", handleNodeMouseOut)
        .on("click", handleNodeClick)
        .call(dragBehaviour());

    // --- 4. LABELS ---
    let labels = labelGroup.selectAll("text.node-label")
        .data(nodes)
        .enter()
        .append("text")
        .attr("class", "node-label")
        .text(d => {
            const type = titleAccessor(d);
            if (type === "CLUSTER" || type === "SUBJECT") return "";

            return d.detail__title ? truncate(d.detail__title, 30) : "";
        })
        .attr("dy", -10);

    // --- FUNZIONE GESTIONE LIVELLI (REDEFINED) ---
    window.updateGraphDepth = function (level, keepRevealed = false) {
        // Reset manual expansion only if triggered by nav bar (not by node click)
        if (!keepRevealed) {
            currentDepthLevel = level;
            revealedNodes.clear();

            // Se cambiamo livello e il nodo selezionato sparisce, nascondi l'anello
            if (selectedNodeData) {
                selectedNodeData = null;
                selectionRing.style("opacity", 0);
            }

            document.querySelectorAll('.nav-btn').forEach((btn, idx) => {
                if ((idx + 1) === level) btn.classList.add('active');
                else btn.classList.remove('active');
            });

            // Update slider position
            const navContainer = document.getElementById("depth-nav");
            if (navContainer) navContainer.dataset.level = level;
        }

        // Hybrid Visibility Logic con filtro temporale
        const isNodeVisible = (d) => {
            const t = titleAccessorGlobal(d);
            
            // Il SUBJECT deve essere sempre visibile come ancora del grafo
            if (t === 'SUBJECT') return true;

            // Filtro TEMPO: Nodo non visibile se nel futuro
            if (d.timestamp && d.timestamp > currentTime) return false;

            // Rule 1: Explicitly revealed
            if (revealedNodes.has(d.id)) return true;

            if (currentDepthLevel === 0) {
                return t === 'SUBJECT';
            }
            if (currentDepthLevel === 1) {
                return t === 'SUBJECT' || t === 'POSITION';
            }
            if (currentDepthLevel === 2) {
                return t !== 'ENTITY';
            }
            return true;
        };

        // Filtra i nodi e gli edge visibili
        const visibleNodes = globalNodes.filter(isNodeVisible);
        const visibleNodeIds = new Set(visibleNodes.map(d => d.id));
        
        // Edges per la fisica (tutti quelli tra nodi visibili, inclusi i cluster per mantenere la struttura)
        const physicsEdges = globalEdges.filter(e => 
            visibleNodeIds.has(e.source.id || e.source) && 
            visibleNodeIds.has(e.target.id || e.target)
        );

        // Edges da disegnare (escludi quelli verso i CLUSTER per pulizia visiva)
        const renderEdges = physicsEdges.filter(e => {
            const s = (typeof e.source === 'object') ? e.source : globalNodes.find(n => n.id === e.source);
            const t = (typeof e.target === 'object') ? e.target : globalNodes.find(n => n.id === e.target);
            return titleAccessorGlobal(s) !== "CLUSTER" && titleAccessorGlobal(t) !== "CLUSTER";
        });

        // Aggiorna la simulazione con i nuovi nodi ed edge
        if (simulation) {
            simulation.nodes(visibleNodes);
            simulation.force("link").links(physicsEdges);
            const alpha = isTimelineUpdate ? 0.02 : 0.3;
            simulation.alpha(alpha).restart();
        }

        // Rebind dei dati ai nodi visivi
        const nodeSelection = nodeGroup.selectAll("path.node").data(visibleNodes, d => d.id);
        nodeSelection.exit().remove();
        const nodeEnter = nodeSelection.enter()
            .append("path")
            .attr("class", "node")
            .attr("d", d => {
                const shapeType = getShapeByType(titleAccessorGlobal(d));
                const radius = getNodeVisualRadius(d);
                const size = Math.PI * Math.pow(radius, 2);
                const symbolType = (shapeType === "diamond") ? d3.symbolDiamond : d3.symbolCircle;
                return d3.symbol().type(symbolType).size(size)();
            })
            .attr("fill", d => getNodeColor(d))
            .attr("stroke", d => hexToRgba(getNodeColor(d), 0.45))
            .attr("stroke-width", 2)
            .attr("opacity", 0) // Start invisible
            .style("pointer-events", d => titleAccessorGlobal(d) === "CLUSTER" ? "none" : "all")
            .on("mouseover", handleNodeMouseOver)
            .on("mousemove", handleNodeMouseMove)
            .on("mouseout", handleNodeMouseOut)
            .on("click", handleNodeClick)
            .call(dragBehaviour());

        // Staggered appearance for new nodes
        const isTutorialOpen = !document.getElementById("tutorial-sidebar").classList.contains('tutorial-closed');
        const shouldStagger = isTimelineUpdate && !isTutorialOpen && isPlaying;

        const enterSize = nodeEnter.size();
        const staggerDelay = shouldStagger ? (enterSize > 50 ? 5 : 10) : 0;

        nodeEnter.transition()
            .duration(0)
            .delay((d, i) => i * staggerDelay)
            .attr("opacity", d => titleAccessorGlobal(d) === "CLUSTER" ? 0 : 1)
            .attr("fill-opacity", d => {
                return activeHighlightFilter ? (activeHighlightFilter(d) ? 1 : 0.15) : 1;
            })
            .attr("stroke-opacity", d => {
                return activeHighlightFilter ? (activeHighlightFilter(d) ? 1 : 0.1) : 1;
            });

        // Rebind delle labels
        const labelSelection = labelGroup.selectAll("text.node-label").data(visibleNodes, d => d.id);
        labelSelection.exit().remove();
        labelSelection.enter()
            .append("text")
            .attr("class", "node-label")
            .text(d => {
                const type = titleAccessorGlobal(d);
                if (type === "CLUSTER" || type === "SUBJECT") return "";
                return d.detail__title ? truncate(d.detail__title, 30) : "";
            })
            .attr("dy", -10)
            .attr("opacity", 0)
            .transition()
            .duration(0)
            .delay((d, i) => i * staggerDelay)
            .attr("opacity", d => activeHighlightFilter ? (activeHighlightFilter(d) ? 1 : 0.1) : 1);

        // Rebind dei link
        const linkSelection = linkGroup.selectAll("line").data(renderEdges, d => `${d.source.id || d.source}-${d.target.id || d.target}`);
        linkSelection.exit().remove();
        linkSelection.enter()
            .append("line")
            .attr("class", "link")
            .attr("stroke-width", d => getLinkStrokeWidth(d))
            .style("stroke-dasharray", d => getLinkDashArray(d))
            .attr("stroke-opacity", 0)
            .transition()
            .duration(0)
            .delay((d, i) => i * staggerDelay)
            .attr("stroke-opacity", d => {
                if (activeHighlightFilter) {
                    const s = d.source.id ? d.source : nodeById.get(d.source);
                    const t = d.target.id ? d.target : nodeById.get(d.target);
                    if (s && t && activeHighlightFilter(s) && activeHighlightFilter(t)) return getLinkOpacity(d, true);
                    return 0.02;
                }
                return getLinkOpacity(d);
            });

        // Aggiorna hulls
        const hullData = visibleNodes.filter(d => titleAccessorGlobal(d) === "CLUSTER");
        const hullSelection = hullGroup.selectAll("path").data(hullData, d => d.id);
        hullSelection.exit().remove();
        
        const hullOpacity = d => {
            const members = globalClusterMembers.get(d.id) || [];
            
            // Filtra solo i nodi argomento per la condizione di comparsa
            const argMembers = members.filter(m => {
                const t = titleAccessorGlobal(m);
                return t === "INFAVOR" || t === "AGAINST";
            });

            // Se il cluster contiene argomenti, basiamo la visibilità su di essi
            const nodesToCheck = argMembers.length > 0 ? argMembers : members;

            const allAppeared = nodesToCheck.every(m => !m.timestamp || m.timestamp <= currentTime);
            return allAppeared ? 1 : 0;
        };

        hullSelection
            .style("opacity", hullOpacity)
            .style("pointer-events", function(d) {
                return hullOpacity(d) == 0 ? "none" : "all";
            });

        hullSelection.enter()
            .append("path")
            .attr("class", "hull")
            .attr("fill", d => getClusterColor(d).fill)
            .attr("stroke", d => getClusterColor(d).stroke)
            .attr("fill-opacity", d => activeHighlightFilter ? (activeHighlightFilter(d) ? 0.5 : 0.1) : 0.25)
            .attr("stroke-opacity", d => activeHighlightFilter ? (activeHighlightFilter(d) ? 1.0 : 0.2) : 0.75)
            .style("opacity", hullOpacity) // L'opacità iniziale è gestita qui
            .style("pointer-events", function(d) {
                return hullOpacity(d) == 0 ? "none" : "all";
            })
            .on("click", handleHullClick)
            .on("mouseover", handleHullMouseOver)
            .on("mousemove", handleHullMouseMove)
            .on("mouseout", handleHullMouseOut);

        // Aggiorna le variabili globali per la simulazione
        node = nodeGroup.selectAll("path.node");
        link = linkGroup.selectAll("line");
        labels = labelGroup.selectAll("text.node-label");
        hulls = hullGroup.selectAll("path");

        if (interactive && !keepRevealed) {
            clearNodeDetails();
            resetHighlight();
        }

        // --- POST-IT VISIBILITY SYNC ---
        // 1. Links: Visible only if target node is visible
        postitLinkGroup.selectAll(".postit-link-group")
            .style("display", d => {
                return (d.target && visibleNodeIds.has(d.target.id)) ? "block" : "none";
            });

        // 2. Post-its: Visible if unlinked OR if at least one linked node is visible
        d3.selectAll(".postit-object").each(function(d) {
            const links = postitLinksData.filter(l => l.source === d);
            let isVisible = true;
            if (links.length > 0) {
                isVisible = links.some(l => l.target && visibleNodeIds.has(l.target.id));
            }
            d3.select(this).style("display", isVisible ? "block" : "none");
        });
    };

    let simulation;
    let collisionForce;

    function initSimulation() {
        initCollisionForce();

        simulation = d3.forceSimulation(globalNodes)
            // Forza di attrazione dei legami
            .force("link", d3.forceLink(globalEdges)
                .id(d => d.id)
                .distance(getLinkDistance)
                .strength(d => {
                    // Legami strutturali più rigidi, menzioni più elastiche
                    if (d.mainStat === "HAS_POSITION") return 0.9;
                    if (d.mainStat === "MENTION") return 0.25;
                    return 0.5;
                })
            )
            // Repulsione (Charge) bilanciata per gerarchia
            .force("charge", d3.forceManyBody()
                .strength(d => {
                    const type = titleAccessorGlobal(d);
                    if (type === "SUBJECT") return -1000; // Il centro spinge per farsi spazio
                    if (type === "ENTITY") return -80;
                    if (type === "INFAVOR" || type === "AGAINST") return -200;    // Le keyword non disturbano la struttura
                    return -400; // Posizioni e Argomenti hanno una repulsione media
                })
                .distanceMax(500)
            )
            // Forza centripeta differenziata (mantiene il Soggetto al centro)
            .force("x", d3.forceX(width / 2).strength(d => titleAccessorGlobal(d) === "SUBJECT" ? 0.5 : 0.01))
            .force("y", d3.forceY(height / 2).strength(d => titleAccessorGlobal(d) === "SUBJECT" ? 0.5 : 0.01))
            .force("collision", collisionForce)
            .force("clustering", createClusteringForce())
            .on("tick", ticked);

        simulation.alphaDecay(0.01); // Raffreddamento leggermente più veloce per stabilità

        simulation.alphaMin(0.001);
    }

    function initCollisionForce() {
        collisionForce = d3.forceCollide()
            .radius(d => {
                // Disattiva collisione per i nodi CLUSTER (che sono invisibili)
                if (titleAccessorGlobal(d) === "CLUSTER") return 0;

                const baseRadius = getNodeVisualRadius(d);
                // Buffer ridotto: 6px per nodi normali, 12px per nodi aperti
                const buffer = d._open ? 12 : 6;
                return baseRadius + buffer + (d._extraCollision || 0);
            })
            .strength(0.2) // Forza alta per evitare sovrapposizioni
            .iterations(4); // Più iterazioni = calcolo fisico più preciso e meno vibrazioni
    }

    // Custom clustering force: attira i nodi verso il loro nodo CLUSTER
    function createClusteringForce() {
        return (alpha) => {
            const clusterStrength = 20; // Forza di attrazione verso il cluster (ridotta, ma più consistente)

            globalClusterMembers.forEach((members, clusterId) => {
                const clusterNode = globalNodes.find(n => n.id === clusterId);
                if (!clusterNode || clusterNode.x === undefined) return;

                // Attira ogni membro verso il nodo CLUSTER
                const visibleMembers = members.filter(m => titleAccessorGlobal(m) !== "CLUSTER" && m.x !== undefined);

                visibleMembers.forEach(node => {
                    const dx = clusterNode.x - node.x;
                    const dy = clusterNode.y - node.y;
                    const distance = Math.sqrt(dx * dx + dy * dy);

                    if (distance > 1) { // Evita divisione per zero
                        const force = clusterStrength * alpha * alpha; // Usa alpha^2 per scalare meglio nel tempo
                        node.vx += (dx / distance) * force;
                        node.vy += (dy / distance) * force;
                    }
                });
            });
        };
    }

    updateSimulationCenter = function(tutorialOpen) {
        if (!simulation) return;

        const tutorialSidebar = document.getElementById("tutorial-sidebar");
        const sidebarWidth = (tutorialOpen && tutorialSidebar) ? tutorialSidebar.getBoundingClientRect().width : 0;
        const graphContainerWidth = document.getElementById("graph-container").clientWidth;
        const cx = sidebarWidth + (graphContainerWidth - sidebarWidth) / 2;
        const cy = height / 2;

        // Rimosso forceCenter per evitare sbalzi (jitter) quando compaiono nuovi nodi periferici
        simulation.force("x", d3.forceX(cx).strength(d => titleAccessorGlobal(d) === "SUBJECT" ? 0.5 : 0.01));
        simulation.force("y", d3.forceY(cy).strength(d => titleAccessorGlobal(d) === "SUBJECT" ? 0.5 : 0.01));
        simulation.alpha(0.3).restart();
    };

    // Helper to calculate handle coordinates for links
    function getHandleCoords(d, handle) {
        const centerOffset = 10; // 15px (CSS offset) - 5px (half size) = 10px from border
        let hx = d.x;
        let hy = d.y;
        if (handle === 'n') { hx += d.width / 2; hy -= centerOffset; }
        if (handle === 'e') { hx += d.width + centerOffset; hy += d.height / 2; }
        if (handle === 's') { hx += d.width / 2; hy += d.height + centerOffset; }
        if (handle === 'w') { hx -= centerOffset; hy += d.height / 2; }
        return [hx, hy];
    }

    let tickCount = 0;

    function ticked() {
        tickCount++;

        // Aggiorna posizioni Archi
        link
            .attr("x1", d => d.source.x)
            .attr("y1", d => d.source.y)
            .attr("x2", d => d.target.x)
            .attr("y2", d => d.target.y);

        // Aggiorna posizioni Nodi
        node.attr("transform", d => `translate(${d.x},${d.y})`);

        // Aggiorna posizioni Link dei Post-it
        postitLinkGroup.selectAll(".postit-link-group").each(function(d) {
            if (!d.target || d.target.x === undefined) return;

            // Dynamically find the closest handle to the target
            const handles = ['n', 'e', 's', 'w'];
            let bestCoords = [0, 0];
            let minSqDist = Infinity;

            handles.forEach(h => {
                const coords = getHandleCoords(d.source, h);
                const dx = coords[0] - d.target.x;
                const dy = coords[1] - d.target.y;
                const distSq = dx * dx + dy * dy;
                if (distSq < minSqDist) {
                    minSqDist = distSq;
                    bestCoords = coords;
                }
            });

            let finalTargetX = d.target.x;
            let finalTargetY = d.target.y;

            // Se il target è un CLUSTER, calcola l'intersezione con l'area (hull)
            if (titleAccessorGlobal(d.target) === "CLUSTER") {
                const hullPoly = getHullPoints(d.target);
                if (hullPoly.length > 0) {
                    const intersect = getPolygonIntersection(bestCoords, [d.target.x, d.target.y], hullPoly);
                    if (intersect) {
                        finalTargetX = intersect[0];
                        finalTargetY = intersect[1];
                    }
                }
            }

            d3.select(this).selectAll("line")
                .attr("x1", bestCoords[0])
                .attr("y1", bestCoords[1])
                .attr("x2", finalTargetX)
                .attr("y2", finalTargetY);
        });

        // Aggiorna posizione Anello di Selezione
        if (selectedNodeData) {
            selectionRing.attr("transform", `translate(${selectedNodeData.x},${selectedNodeData.y})`);
        }

        // Aggiorna etichette fisse e hover
        labels.attr("x", d => d.x).attr("y", d => d.y - 10);
        labelGroup.selectAll(".entity-hover-label, .entity-perm-label")
            .attr("x", d => d.x)
            .attr("y", d => d.y);

        labelGroup.selectAll(".entity-perm-label")
            .attr("transform", d => `translate(${d.x},${d.y})`);

        // --- ADAPTIVE HULL REFRESH ---
        // Ottimizziamo il calcolo dei poligoni (hull) in base all'attività della simulazione.
        // Quando i nodi si muovono velocemente (alpha alto), aggiorniamo spesso.
        // Quando rallentano, riduciamo la frequenza per risparmiare CPU.
        const alpha = simulation.alpha();
        let hullModulo = 1;
        
        // Force frequent updates during playback to ensure responsiveness
        if (isPlaying) hullModulo = 1;
        else if (alpha > 0.1) hullModulo = 2;       // Movimento rapido: ogni 2 tick
        else if (alpha > 0.03) hullModulo = 4; // Movimento rallentato: ogni 8 tick
        else hullModulo = 12;                 // Quasi statico: ogni 24 tick

        if (tickCount % hullModulo === 0 || alpha <= simulation.alphaMin() + 0.001) {
            hulls.attr("d", d => getHullPath(d));
        }

        // Aggiorna nodi Minimappa
        const mContainer = document.getElementById("minimap-container");
        const mWidth = mContainer ? mContainer.clientWidth : 160;
        const mHeight = minimapSvg.node() ? minimapSvg.node().getBoundingClientRect().height : mWidth;
        const subjectNode = globalNodes.find(n => titleAccessorGlobal(n) === "SUBJECT");
        const refX = subjectNode && subjectNode.x !== undefined ? subjectNode.x : width / 2;
        const refY = subjectNode && subjectNode.y !== undefined ? subjectNode.y : height / 2;

        minimapNodes
            .attr("cx", d => (d.x - refX) * minimapScale + mWidth / 2)
            .attr("cy", d => (d.y - refY) * minimapScale + mHeight / 2);
        
        // Aggiorna viewport minimappa (nel caso la simulazione sposti il centro o all'avvio)
        if (updateMinimapViewport) updateMinimapViewport(d3.zoomTransform(svg.node()));
    }

    function dragBehaviour() {
        function dragstarted(event, d) {
            if (!interactive) return;
            // Physics update removed from start to avoid waking up simulation on click/hold
            d.fx = d.x;
            d.fy = d.y;
        }

        function dragged(event, d) {
            if (!interactive) return;
            // Physics update happens only when actually dragging
            simulation.alphaTarget(0.3).restart();
            d.fx = event.x;
            d.fy = event.y;
        }

        function dragended(event, d) {
            if (!interactive) return;
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
        }

        return d3.drag()
            .on("start", dragstarted)
            .on("drag", dragged)
            .on("end", dragended);
    }

    function buildTooltipHTML(d) {
        const title = d.detail__title || d.title || "";
        let type = d.mainStat || titleAccessor(d) || "unknown";
        const typeColor = getNodeColor(d);
        if (type === "ENTITY") type = "KEYWORD";
        let sub = d.subStat || "";
        if (sub.toUpperCase() === "ENTITY") sub = "";
        const text = d.detail__text || "";
        
        // Unify Type and Title: Type first (Mono, Colored), then Title (Sans, Primary)
        const typeHTML = `<div style="font-family: var(--font-mono); font-size: var(--fs-small); text-transform: uppercase; margin-bottom: 4px; color: ${typeColor}; font-weight: var(--fw-bold);">${escapeHTML(type)}${sub ? " · " + escapeHTML(sub) : ""}</div>`;
        
        // Only show title if it's not redundant with the type string (prevents duplicates in Subject nodes)
        const isRedundant = title && (title.toUpperCase() === type.toUpperCase() || (type === "KEYWORD" && title.toUpperCase() === "ENTITY"));
        const titleColor = (titleAccessorGlobal(d) === "SUBJECT") ? "var(--c-text-primary)" : typeColor;
        const titleHTML = (title && !isRedundant) ? `<strong style="color: ${titleColor}; display: block; margin-bottom: 2px; font-family: var(--font-sans);">${escapeHTML(title)}</strong>` : "";

        return `
            ${typeHTML}
            ${titleHTML}
            <div style="font-size: var(--fs-small); margin-bottom: 8px; line-height: var(--lh-tight); color: var(--c-text-primary); font-family: var(--font-sans);">${escapeHTML(truncate(text, 70))}</div>
            <div style="font-family: var(--font-mono); font-size: var(--fs-tiny); text-transform: uppercase; opacity: 1; border-top: 1px solid var(--c-border); padding-top: 4px; color: var(--c-text-secondary);">Click for details</div>
        `;
    }

    function moveTooltip(event) {
        const padding = 15;
        const tooltipNode = tooltip.node();
        const bBox = tooltipNode.getBoundingClientRect();

        let x = event.pageX + padding;
        let y = event.pageY + padding;

        // Controllo margine destro: se esce, lo sposta a sinistra del cursore
        if (x + bBox.width > window.innerWidth) {
            x = event.pageX - bBox.width - padding;
        }

        // Controllo margine inferiore: se esce, lo sposta sopra il cursore
        if (y + bBox.height > window.innerHeight) {
            y = event.pageY - bBox.height - padding;
        }

        // Controllo margine superiore: se dopo lo spostamento esce sopra, lo riporta sotto
        if (y < 0) y = event.pageY + padding;

        tooltip
            .style("left", x + "px")
            .style("top", y + "px");
    }

    svg.on("click", (event) => {
        if (event.defaultPrevented) return; // Prevent physics update if panning/zooming

        // Prevent background click actions (reset/restart) when in drawing mode
        if (isDrawingMode) return;

        if (isAddingPostit) {
            const coords = d3.pointer(event, g.node());
            createPostit(coords[0], coords[1]);
            togglePostitMode(false);
            return;
        }

        if (!interactive) return;
        clearNodeDetails();
        resetHighlight();
        resetEntitiesVisuals();
        
        // Reset anello selezione
        selectedNodeData = null;
        selectionRing.style("opacity", 0);

        // Pulisci la ricerca se si clicca sullo sfondo
        const searchInput = document.getElementById("search-input");
        if (searchInput) searchInput.value = "";

        // Rimuovi selezione visiva
        nodeGroup.selectAll(".node").classed("selected", false);

        // Deselect postits
        d3.selectAll(".postit-wrapper").classed("selected", false);

        // Reset Toggles
        const tContested = document.getElementById("toggle-contested");
        const tLone = document.getElementById("toggle-lone");
        const tShared = document.getElementById("toggle-shared");
        if (tContested) tContested.checked = false;
        if (tLone) tLone.checked = false;
        if (tShared) tShared.checked = false;
    });

    let currentSelectedNodeId = null; // Gestione race condition per richieste asincrone

    async function addWikipediaLink(keyword, containerElement, nodeId) {
        // 1. Pulizia profonda della keyword: rimuoviamo punteggiatura finale che spesso l'AI include
        // e che blocca il matching esatto di Wikipedia.
        let cleanKeyword = keyword.replace(/[.,;:]+$/, "").trim();
        
        // Primo tentativo: opensearch (veloce e preciso per titoli esatti)
        const openSearchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(cleanKeyword)}&limit=1&namespace=0&format=json&origin=*`;

        try {
            let response = await fetch(openSearchUrl);
            let data = await response.json();
            let wikiUrl = null;

            if (nodeId !== currentSelectedNodeId) return;

            if (data[1] && data[1].length > 0) {
                wikiUrl = data[3][0];
            } else {
                // 2. FALLBACK: Se opensearch fallisce (comune con 3+ parole), usiamo la ricerca testuale.
                // srlimit=1 ci dà il risultato più rilevante in assoluto.
                const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(cleanKeyword)}&srlimit=1&format=json&origin=*`;
                const searchRes = await fetch(searchUrl);
                const searchData = await searchRes.json();

                if (nodeId !== currentSelectedNodeId) return;

                if (searchData.query && searchData.query.search && searchData.query.search.length > 0) {
                    const bestMatch = searchData.query.search[0].title;
                    wikiUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(bestMatch.replace(/ /g, "_"))}`;
                }
            }

            // Se abbiamo trovato un URL (tramite opensearch o fallback), mostriamo il bottone
            if (wikiUrl) {
                // Crea contenitore per il bottone per separarlo dal testo
                const btnContainer = document.createElement("div");
                btnContainer.style.marginTop = "12px";
                btnContainer.style.marginBottom = "8px";

                // Bottone con stile
                btnContainer.innerHTML = `
                    <a href="${wikiUrl}" target="_blank" class="wiki-btn">Read more on Wikipedia →</a>
                    <div class="wiki-disclaimer">Note: Search relevance may vary for complex or multi-word concepts.</div>
                `;
                
                containerElement.appendChild(btnContainer);
            }
        } catch (error) {
            console.error("Errore Wikipedia API:", error);
        }
    }

    // --- NAVIGATION SEQUENCE HELPER ---
    function getNavigationSequence() {
        // 1. Get all POSITION nodes and sort by timestamp
        const positions = globalNodes.filter(n => titleAccessorGlobal(n) === "POSITION");
        positions.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
        
        const sequence = [];
        const visitedArgs = new Set();

        positions.forEach(pos => {
            // Add Position
            sequence.push(pos);
            
            // Find arguments linked to this position
            const args = [];
            globalEdges.forEach(e => {
                const s = e.source; // Node object (after simulation init)
                const t = e.target; // Node object
                let neighbor = null;
                
                if (s.id === pos.id) neighbor = t;
                else if (t.id === pos.id) neighbor = s;
                
                if (neighbor) {
                    const type = titleAccessorGlobal(neighbor);
                    if (type === "INFAVOR" || type === "AGAINST") {
                        args.push(neighbor);
                    }
                }
            });
            
            // Sort arguments by timestamp
            args.sort((a, b) => (a.timestamp || 0) - (b.timestamp || 0));
            
            args.forEach(arg => {
                if (!visitedArgs.has(arg.id)) {
                    sequence.push(arg);
                    visitedArgs.add(arg.id);
                }
            });
        });
        
        return sequence;
    }

    function getStableAiConfidence(nodeData) {
        const rawConfidence = Number(nodeData.detail__ai_confidence ?? nodeData.ai_confidence);
        if (Number.isFinite(rawConfidence)) {
            const normalized = rawConfidence <= 1 ? rawConfidence * 100 : rawConfidence;
            return Math.max(0, Math.min(100, Math.round(normalized)));
        }

        // Fallback: deterministic pseudo-score to avoid random jumps while browsing nodes.
        const seed = String(nodeData.id || nodeData.detail__title || "ai-node");
        let hash = 0;
        for (let i = 0; i < seed.length; i++) {
            hash = ((hash << 5) - hash) + seed.charCodeAt(i);
            hash |= 0;
        }
        return 82 + (Math.abs(hash) % 17);
    }

    function showNodeDetails(d) {
        const detailsCard = d3.select("#details-card");
        detailsCard.classed("visible", true);
        
        // Attiva l'effetto "push" sulla legenda
        d3.select("#info-panel").classed("details-active", true);
        
        // Aggiorna ID corrente per gestire le richieste async
        currentSelectedNodeId = d.id;

        // --- 1. HEADER: User & Type ---
        const avatarContainer = d3.select("#user-avatar");
        const nameContainer = d3.select("#user-name");
        const typesContainer = d3.select("#node-types");
        
        typesContainer.selectAll("*").remove();
        avatarContainer.selectAll("*").remove();

        // Determine User/Author
        let authorName = "System";
        let isHuman = false;

        if (d.detail__author_id) {
            const cleanAuthorId = String(d.detail__author_id).replace(/['"]+/g, '').trim();
            const mapName = authorMap.get(cleanAuthorId);
            authorName = mapName || "Anonymous User";
            isHuman = true;
        } else {
            // Fallback for non-human nodes
            const t = titleAccessorGlobal(d);
            if (t === "CLUSTER") authorName = "Cluster";
            else if (t === "ENTITY") authorName = String(d.detail__value || d.detail__title || "Keyword").replace(/['"]+/g, '').trim();
            else if (t === "SUBJECT") authorName = "Topic";
        }

        nameContainer.text(authorName);

        // Avatar Icon
        if (isHuman) {
            avatarContainer.html(`
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                    <circle cx="12" cy="7" r="4"></circle>
                </svg>
            `);
        } else {
            avatarContainer.html(`
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
            `);
        }

        // Node Type Pill
        const rawNodeType = titleAccessorGlobal(d);
        let nodeType = rawNodeType;
        if (nodeType === "CLUSTER") nodeType = "ARGUMENT CLUSTER";
        if (nodeType === "ENTITY") nodeType = "KEYWORD";

        // Calcola il colore base per la pillola
        let typeColor;
        if (titleAccessorGlobal(d) === "CLUSTER") {
            typeColor = getClusterColor(d).stroke; // Usa il colore del bordo del cluster
        } else {
            typeColor = getNodeColor(d);
        }

        typesContainer.append("span")
            .attr("class", "pill")
            .style("background-color", hexToRgba(typeColor, 0.15)) // Tinta leggera
            .style("border", `1px solid ${hexToRgba(typeColor, 0.3)}`) // Bordo sottile coordinato
            .text(nodeType);

        // Date Pill
        const rawTypeForDate = titleAccessorGlobal(d);
        if ((rawTypeForDate === "POSITION" || rawTypeForDate === "INFAVOR" || rawTypeForDate === "AGAINST") && d.timestamp) {
            const dateStr = new Date(d.timestamp).toLocaleString(undefined, { 
                year: 'numeric', 
                month: 'short', 
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
            typesContainer.append("span")
                .attr("class", "pill")
                .style("background-color", "var(--c-bg-inset)")
                .style("border", "1px solid var(--c-border-strong)")
                .style("color", "var(--c-text-secondary)")
                .text(dateStr);
        }

        const aiInfoSection = d3.select("#details-ai-info");
        const aiInfoToggle = d3.select("#details-ai-info-toggle");
        const aiInfoContent = d3.select("#details-ai-info-content");
        const aiInfoText = d3.select("#ai-info-text");
        const aiConfidenceText = d3.select("#ai-confidence-text");
        const isAiGeneratedNode = rawNodeType === "CLUSTER" || rawNodeType === "ENTITY";

        if (isAiGeneratedNode) {
            const confidence = getStableAiConfidence(d);
            const scopeText = rawNodeType === "CLUSTER"
                ? "The model groups arguments by semantic similarity and stance context to form thematic clusters."
                : "The model extracts recurring semantic entities and links arguments through shared concepts.";

            aiInfoText.text(scopeText);
            aiConfidenceText.text(`Confidence ${confidence}%: high internal consistency in the AI assignment, not factual certainty.`);
            aiInfoSection.style("display", "block").classed("open", false);
            aiInfoToggle.attr("aria-expanded", "false");
            aiInfoContent.attr("aria-hidden", "true");

            aiInfoToggle.on("click", (event) => {
                event.stopPropagation();
                const shouldOpen = !aiInfoSection.classed("open");
                aiInfoSection.classed("open", shouldOpen);
                aiInfoToggle.attr("aria-expanded", shouldOpen ? "true" : "false");
                aiInfoContent.attr("aria-hidden", shouldOpen ? "false" : "true");
            });
        } else {
            aiInfoSection.style("display", "none").classed("open", false);
            aiInfoToggle.attr("aria-expanded", "false");
            aiInfoContent.attr("aria-hidden", "true");
            aiInfoToggle.on("click", null);
        }

        const displayTitle = (titleAccessorGlobal(d) === "CLUSTER") ?
            (d.detail__tagline || d.detail__title || "") :
            (d.detail__title || "");

        const displayText = (titleAccessorGlobal(d) === "CLUSTER") ?
            (d.detail__summary || d.detail__text || "") :
            (d.detail__text || "");

        d3.select("#node-title")
            .text(displayTitle)
            .style("display", displayTitle ? "block" : "none");
            
        const textContainer = d3.select("#node-text");
        textContainer.text(displayText);

        // --- ACTIONS FOOTER (Nav + Origin) ---
        let actionsFooter = detailsCard.select("#details-actions");
        if (actionsFooter.empty()) {
            actionsFooter = detailsCard.append("div").attr("id", "details-actions");
        }
        actionsFooter.html(""); // Clear previous content

        const rawType = titleAccessorGlobal(d);
        
        // Only show navigation for Positions and Arguments
        if (rawType === "POSITION" || rawType === "INFAVOR" || rawType === "AGAINST") {
            const sequence = getNavigationSequence();
            const currentIndex = sequence.findIndex(n => n.id === d.id);
            
            if (currentIndex !== -1) {
                const navContainer = actionsFooter.append("div")
                    .attr("id", "details-nav-container");

                // PREVIOUS BUTTON
                const prevBtn = navContainer.append("button")
                    .attr("class", "details-nav-btn")
                    .html(`<span>←</span> Previous`)
                    .property("disabled", currentIndex === 0)
                    .on("click", function() {
                        const prevNode = sequence[currentIndex - 1];
                        if (prevNode) {
                            // Trigger click on the node to activate all selection logic
                            nodeGroup.selectAll("path.node").filter(n => n.id === prevNode.id).dispatch("click");
                        }
                    });

                // NEXT BUTTON
                const nextBtn = navContainer.append("button")
                    .attr("class", "details-nav-btn")
                    .html(`Next <span>→</span>`)
                    .property("disabled", currentIndex === sequence.length - 1)
                    .on("click", function() {
                        const nextNode = sequence[currentIndex + 1];
                        if (nextNode) {
                            nodeGroup.selectAll("path.node").filter(n => n.id === nextNode.id).dispatch("click");
                        }
                    });
            }
        }

        // --- ORIGINAL CONTRIBUTION BUTTON ---
        if (rawType === "POSITION" || rawType === "INFAVOR" || rawType === "AGAINST") {
            actionsFooter.append("div")
                .attr("id", "details-origin-container")
                .append("button")
                .attr("class", "origin-btn")
                .html(`
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                        <polyline points="15 3 21 3 21 9"></polyline>
                        <line x1="10" y1="14" x2="21" y2="3"></line>
                    </svg>
                    Go to original contribution
                `)
                .on("click", () => showOriginFeedback());
        }

        const statsContainer = d3.select("#details-stats");
        if (statsContainer.select("#node-value").empty()) {
            statsContainer.html('<div class="section-title">Stats</div><div id="node-value"></div>');
        }
        const statsTitle = statsContainer.select(".section-title");
        const nodeValueContainer = d3.select("#node-value");
        nodeValueContainer.html("");

        const type = titleAccessorGlobal(d);

        if (type === "POSITION") {
            statsTitle.style("display", "block");
            let pro = 0;
            let con = 0;
            const getId = (n) => (typeof n === 'object' && n.id) ? n.id : n;

            globalEdges.forEach(e => {
                const sId = getId(e.source);
                const tId = getId(e.target);
                if (sId === d.id || tId === d.id) {
                    const neighborId = (sId === d.id) ? tId : sId;
                    const neighborNode = nodeById.get(neighborId);
                    if (neighborNode) {
                        const type = titleAccessorGlobal(neighborNode);
                        if (type === "INFAVOR") pro++;
                        if (type === "AGAINST") con++;
                    }
                }
            });

            const createPill = (count, label, color) => {
                return `
                    <div style="flex: 1; display: flex; flex-direction: column; padding: 12px; background: var(--c-bg-panel); border: 1px solid var(--c-border);">
                        <span style="font-family: var(--font-mono); font-size: var(--fs-small); color: var(--c-text-muted); text-transform: uppercase; margin-bottom: 4px;">${label}</span>
                        <span style="font-family: var(--font-mono); font-size: var(--fs-h2); font-weight: var(--fw-bold); color: ${color};">${count}</span>
                    </div>`;
            };

            let html = `<div style="display: flex; gap: 10px; width: 100%;">`;
            html += createPill(pro, "INFAVOUR", colorMap["INFAVOR"]);
            html += createPill(con, "AGAINST", colorMap["AGAINST"]);
            html += `</div>`;
            nodeValueContainer.html(html);

        } else if (type === "SUBJECT") {
            statsTitle.style("display", "block");

            // Helper per formattare date (dd/mm/yyyy)
            const formatDate = (ts) => {
                if (!ts) return "N/A";
                const d = new Date(ts);
                return d.toLocaleDateString('en-GB');
            };
            const dateRange = `${formatDate(timeDomain[0])} - ${formatDate(timeDomain[1])}`;

            // Calcolo conteggi totali
            const nPos = globalNodes.filter(n => titleAccessorGlobal(n) === "POSITION").length;
            const nArgs = globalNodes.filter(n => {
                const t = titleAccessorGlobal(n);
                return t === "INFAVOR" || t === "AGAINST";
            }).length;
            const nClust = globalNodes.filter(n => titleAccessorGlobal(n) === "CLUSTER").length;
            const nEnt = globalNodes.filter(n => titleAccessorGlobal(n) === "ENTITY").length;

            // Costruzione HTML
            let html = `<div class="stats-container">`;
            
            // Riga Date
            html += `
                <div class="stats-timeline-box">
                    <span class="stats-label">Timeline Range</span>
                    <span class="stats-value-date">${dateRange}</span>
                </div>
            `;

            // Griglia Statistiche
            html += `<div class="stats-grid">`;
            
            const createStatBox = (label, count, color) => `
                <div class="stats-box">
                    <span class="stats-label">${label}</span>
                    <span class="stats-value-count" style="color: ${color};">${count}</span>
                </div>
            `;

            html += createStatBox("Positions", nPos, colorMap["POSITION"]);
            html += createStatBox("Arguments", nArgs, "var(--c-text-primary)"); 
            html += createStatBox("Clusters", nClust, "#7b91b3"); 
            html += createStatBox("Keywords", nEnt, colorMap["ENTITY"]);
            
            html += `</div></div>`;
            
            nodeValueContainer.html(html);

        } else if (type === "CLUSTER") {
            statsTitle.style("display", "block");
            const allMems = globalClusterMembers.get(d.id) || [];
            
            let inFavor = 0;
            let against = 0;
            allMems.forEach(m => {
                const t = titleAccessorGlobal(m);
                if (t === "INFAVOR") inFavor++;
                if (t === "AGAINST") against++;
            });

            const createPill = (count, label, color) => {
                return `
                    <div style="flex: 1; display: flex; flex-direction: column; padding: 12px; background: var(--c-bg-panel); border: 1px solid var(--c-border);">
                        <span style="font-family: var(--font-mono); font-size: var(--fs-small); color: var(--c-text-muted); text-transform: uppercase; margin-bottom: 4px;">${label}</span>
                        <span style="font-family: var(--font-mono); font-size: var(--fs-h2); font-weight: var(--fw-bold); color: ${color};">${count}</span>
                    </div>`;
            };

            let html = `<div style="display: flex; gap: 10px; width: 100%;">`;
            html += createPill(inFavor, "INFAVOUR", colorMap["INFAVOR"]);
            html += createPill(against, "AGAINST", colorMap["AGAINST"]);
            html += `</div>`;
            nodeValueContainer.html(html);
        } else if (type === "INFAVOR" || type === "AGAINST" || type === "ENTITY") {
            statsTitle.style("display", "none");
        } else {
            let stats = "";
            if (d.detail__value && d.detail__value !== "") {
                stats = `Value: ${String(d.detail__value).replace(/['"]+/g, '')}`;
            }
            nodeValueContainer.text(stats);
            statsTitle.style("display", stats ? "block" : "none");
        }

        // --- CUSTOM POPUP LOGIC ---
        window.showCustomPopup = function(title, message) {
            let overlay = d3.select("#custom-popup-overlay");
            if (overlay.empty()) {
                overlay = d3.select("body").append("div")
                    .attr("id", "custom-popup-overlay")
                    .attr("class", "custom-popup-overlay");
                
                const popup = overlay.append("div")
                    .attr("class", "custom-popup");
                
                popup.append("h3").attr("id", "popup-title");
                popup.append("p").attr("id", "popup-message");
                
                popup.append("button")
                    .attr("class", "custom-popup-close")
                    .text("Close")
                    .on("click", () => overlay.classed("visible", false));
                    
                overlay.on("click", (event) => {
                    if (event.target === overlay.node()) overlay.classed("visible", false);
                });
            }
            overlay.select("#popup-title").text(title);
            overlay.select("#popup-message").text(message);
            overlay.classed("visible", true);
        };

        window.showContestFeedback = function() {
            showCustomPopup(
                "Feedback Recorded",
                "Thank you for your contribution. Your contestation has been logged and will be used to refine the AI's thematic classification and semantic extraction models."
            );
        };

        window.showOriginFeedback = function() {
            showCustomPopup(
                "Original Contribution",
                "This feature is currently under development. In the future, this button will securely redirect you to the original platform where this contribution was posted, allowing you to verify the full context and metadata."
            );
        };

        // --- CONTEST AI CLASSIFICATION ---
        // Remove previous contestation UI if present to avoid duplicates
        statsContainer.select("#contest-action-container").remove();
        
        let contestHtml = "";

        if (type === "ENTITY") {
            contestHtml = `
                <div id="contest-action-container">
                    <span class="section-title-ai">Semantic Bridge Integrity</span>
                    <p style="font-size: var(--fs-small); color: var(--c-text-secondary); margin-bottom: 10px; line-height: var(--lh-normal);">This keyword was extracted by <span class=\"ai-text-p\">AI</span> to link different parts of the debate. If you find this concept irrelevant or believe it creates a "false relation" between arguments, you can contest it.</p>
                    <button class="contest-btn" onclick="showContestFeedback()">
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                        Contest Keyword Extraction
                    </button>
                </div>
            `;
        } else if (type === "INFAVOR" || type === "AGAINST") {
            const clusterId = nodeToClusterMap.get(d.id);
            if (clusterId) {
                const clusterNode = nodeById.get(clusterId);
                const clusterName = clusterNode ? (clusterNode.detail__tagline || "this thematic area") : "this thematic area";
                contestHtml = `
                    <div id="contest-action-container">
                        <span class="section-title-ai">Clustering Feedback</span>
                        <p style="font-size: var(--fs-small); color: var(--c-text-secondary); margin-bottom: 10px; line-height: var(--lh-normal);"><span class=\"ai-text-p\">AI</span> has has grouped this argument within <strong>${clusterName}</strong>. If this thematic classification feels incorrect to you, please flag it.</p>
                        <button class="contest-btn" onclick="showContestFeedback()">
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="margin-right: 4px;"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
                            Contest AI Clustering
                        </button>
                    </div>
                `;
            }
        }

        if (contestHtml) {
            // Append the contestation UI to the existing stats container
            statsContainer.node().insertAdjacentHTML('beforeend', contestHtml);
            statsContainer.style("display", "block");
        } else {
            // Show the container only if standard stats (like Position metrics) exist
            const hasStats = nodeValueContainer.html().trim() !== "";
            statsContainer.style("display", hasStats ? "block" : "none");
        }

        // --- WIKIPEDIA INTEGRATION ---
        // Se è una Keyword (ENTITY), cerca su Wikipedia
        if (titleAccessorGlobal(d) === "ENTITY") {
            let keyword = d.detail__value || d.detail__title;
            if (keyword) {
                keyword = String(keyword).replace(/['"]+/g, '').trim();
                addWikipediaLink(keyword, textContainer.node(), d.id);
            }
        }
    }

    function showConnectedEntitiesText(argNode) {
        if (!argNode) return;

        const connected = edges.map(e => {
            if (e.source.id === argNode.id) return e.target;
            if (e.target.id === argNode.id) return e.source;
            return null;
        }).filter(Boolean).filter(n => titleAccessor(n) === "ENTITY");

        connected.forEach(ent => {
            const existing = labelGroup.selectAll('.entity-perm-label').filter(d => d.id === ent.id);
            if (!existing.empty()) return;

            node.filter(n => n.id === ent.id)
                .attr('opacity', 0.1);

            const g = labelGroup.append('g')
                .datum(ent)
                .attr('class', 'entity-perm-label')
                .style('pointer-events', 'none');

            const textVal = ent.detail__value || ent.detail__title || '';

            const textEl = g.append('text')
                .attr('text-anchor', 'middle')
                .attr('alignment-baseline', 'middle')
                .text(truncate(textVal, 180));

            requestAnimationFrame(() => {
                try {
                    const bbox = textEl.node().getBBox();
                    const pad = 8;
                    ent._open = true;
                    const measured = Math.max(bbox.width, bbox.height);
                    const reduced = Math.max(4, measured / 8);
                    const cap = 30;
                    ent._extraCollision = Math.min(reduced + pad + 6, cap);

                    if (collisionForce && simulation) {
                        collisionForce.radius(d => (getNodeVisualRadius(d) + 5 + (d._extraCollision || 0)));
                        simulation.force("collision", collisionForce);

                        // NUOVO: Aggiorna le distanze dei link ora che ent._open è true
                        // FIX: Usa i link correnti della simulazione, non 'edges' raw
                        simulation.force("link").links(simulation.force("link").links());

                        simulation.alpha(0.1).restart();
                    }
                    g.attr('transform', `translate(${ent.x},${ent.y})`);
                } catch (e) {
                    g.attr('transform', `translate(${ent.x},${ent.y})`);
                }
            });
        });
    }

    function resetEntitiesVisuals() {
        labelGroup.selectAll('.entity-perm-label').remove();
        node.filter(d => titleAccessor(d) === 'ENTITY')
            .attr('opacity', 1);

        nodes.forEach(n => {
            n._open = false;
            n._extraCollision = 0;
        });

        if (collisionForce) {
            collisionForce.radius(d => (getNodeVisualRadius(d) + 5 + (d._extraCollision || 0)));
            if (simulation) {
                simulation.force("collision", collisionForce);
                // FIX: Usa i link correnti della simulazione, non 'edges' raw
                simulation.force("link").links(simulation.force("link").links());
                simulation.alpha(0.05).restart();
            }
        }
    }

    function clearNodeDetails() {
        // MODIFICA UI: Nascondiamo la card inferiore rimuovendo la classe visible
        d3.select("#details-card").classed("visible", false);
        // Ripristina la legenda
        d3.select("#info-panel").classed("details-active", false);
        d3.select("#details-ai-info").style("display", "none").classed("open", false);
        d3.select("#details-ai-info-toggle").attr("aria-expanded", "false");
        d3.select("#details-ai-info-content").attr("aria-hidden", "true");
    }

    function truncate(str, max) {
        if (!str) return "";
        return str.length > max ? str.slice(0, max - 1) + "…" : str;
    }

    function escapeHTML(str) {
        if (!str) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function zoomToNodes(filterFn) {
        const selected = nodes.filter(filterFn);
        if (selected.length === 0) return;

        const margin = 100; //

        const minX = d3.min(selected, d => d.x);
        const maxX = d3.max(selected, d => d.x);
        const minY = d3.min(selected, d => d.y);
        const maxY = d3.max(selected, d => d.y);

        const widthSel = maxX - minX || 1;
        const heightSel = maxY - minY || 1;

        const availableWidth = document.getElementById("graph-container").clientWidth;
        const availableHeight = document.getElementById("graph-container").clientHeight;

        const scale = Math.min(
            (availableWidth - margin) / widthSel,
            (availableHeight - margin) / heightSel,
            2
        );

        const centerX = (minX + maxX) / 2;
        const centerY = (minY + maxY) / 2;

        const transform = d3.zoomIdentity
            .translate(availableWidth / 2, availableHeight / 2)
            .scale(scale)
            .translate(-centerX, -centerY);

        svg.transition().duration(600).call(zoom.transform, transform);
    }

    function resetZoom() {
        svg.transition().duration(600).call(zoom.transform, d3.zoomIdentity);
    }

    const topDegreeNodes = [...nodes].sort((a, b) => b.degree - a.degree).slice(0, 5);

    let currentStep = 0;

    const tutorialContent = document.getElementById("tutorial-content");
    const tutorialNext = document.getElementById("tutorial-next");
    const tutorialBack = document.getElementById("tutorial-back");
    const tutorialSkip = document.getElementById("tutorial-skip");
    const tutorialStepper = document.getElementById("tutorial-stepper");
    const tutorialSidebar = document.getElementById("tutorial-sidebar");
    const tutorialToggle = document.getElementById("tutorial-toggle");
    const infoPanel = document.getElementById("info-panel");
    const depthNav = document.getElementById("depth-nav");
    const detailsCloseBtn = document.getElementById("details-close-btn");

    if (detailsCloseBtn) {
        detailsCloseBtn.addEventListener("click", (event) => {
            event.stopPropagation();
            clearNodeDetails();
        });
    }

    function collapseInfoPanel() {
        if (!infoPanel) return;
        infoPanel.classList.add('collapsed');
    }

    function expandInfoPanel() {
        if (!infoPanel) return;
        infoPanel.classList.remove('collapsed');
    }

    function updateStepper() {
        tutorialStepper.innerHTML = "";
        tutorialSteps.forEach((_, i) => {
            const dot = document.createElement("div");
            dot.className = "step-dot";
            if (i === currentStep) dot.classList.add("active");
            tutorialStepper.appendChild(dot);
        });
    }

    function applyTutorialFocus() {
        const step = tutorialSteps[currentStep];
        const type = step.focusType;

        if (type === "ALL" || !type) {
            resetHighlight();
            resetZoom();
            return;
        }

        // FIX: Gestione specifica per ENTITY (Keywords)
        // Quando compaiono (passaggio da depth 2 a 3), sono al centro e "esplodono".
        // Invece di zoomare su di loro (che causerebbe uno zoom eccessivo al centro),
        // inquadriamo l'intero grafo usando i nodi già stabili (Position/Arguments).
        if (type === "ENTITY") {
            const capturedStep = currentStep;
            const targetNodes = globalNodes.filter(d => {
                const t = titleAccessorGlobal(d);
                return t === "ENTITY" || t === "SUBJECT";
            });
            const targetIds = new Set(targetNodes.map(n => n.id));
            highlightNodes(n => targetIds.has(n.id));
            setTimeout(() => {
                if (currentStep === capturedStep) resetZoomToFit();
            }, 1500); // Attendi l'esplosione delle keyword prima di centrare
            return;
        }

        let targetNodes = [];

        if (type === "OUTDEGREE") {
            // Seleziona solo i nodi POSITION, ordinali per grado e prendi i due estremi
            const positions = globalNodes.filter(n => titleAccessorGlobal(n) === "POSITION");
            if (positions.length > 0) {
                positions.sort((a, b) => (b.degree || 0) - (a.degree || 0));
                targetNodes.push(positions[0]); // Il più grande
                if (positions.length > 1) targetNodes.push(positions[positions.length - 1]); // Il più piccolo
            }
        } else {
            targetNodes = globalNodes.filter(d => {
                const t = titleAccessorGlobal(d);
                if (type === "SUBJECT") return t === "SUBJECT";
                if (type === "POSITION") return t === "POSITION";
                if (type === "INFAVOR_AGAINST") return t === "INFAVOR" || t === "AGAINST";
                if (type === "CLUSTER") return t === "CLUSTER";
                return false;
            });
        }

        if (targetNodes.length > 0) {
            const targetIds = new Set(targetNodes.map(n => n.id));
            
            let filterFn = n => targetIds.has(n.id);
            // Mantieni visibili i nodi strutturali (padri) per mostrare i collegamenti
            if (type === "POSITION") {
                filterFn = n => targetIds.has(n.id) || titleAccessorGlobal(n) === "SUBJECT";
            } else if (type === "INFAVOR_AGAINST") {
                filterFn = n => targetIds.has(n.id);
            }
            highlightNodes(filterFn);

            // FUNZIONE RECORSIVA PER ATTENDERE LE COORDINATE
            const performZoom = (attempts) => {
                const minX = d3.min(targetNodes, d => d.x);
                const maxX = d3.max(targetNodes, d => d.x);

                // Se le coordinate sono ancora identiche (tutti al centro), riprova tra 100ms
                if (minX === maxX && attempts < 10) {
                    setTimeout(() => performZoom(attempts + 1), 100);
                    return;
                }

                const minY = d3.min(targetNodes, d => d.y);
                const maxY = d3.max(targetNodes, d => d.y);

                const selWidth = (maxX - minX) || 100;
                const selHeight = (maxY - minY) || 100;
                const midX = (minX + maxX) / 2;
                const midY = (minY + maxY) / 2;

                const isSidebarOpen = !document.getElementById("tutorial-sidebar").classList.contains('tutorial-closed');
                const sidebarOffset = isSidebarOpen ? 360 : 0;
                const availableWidth = width - sidebarOffset;

                let scale = Math.min(2.5, 0.7 / Math.max(selWidth / availableWidth, selHeight / height));
                if (targetNodes.length === 1) scale = 1.8;

                const centerX = sidebarOffset + (availableWidth / 2);
                const centerY = height / 2;

                svg.transition()
                    .duration(1500)
                    .ease(d3.easeCubicInOut)
                    .call(zoom.transform, d3.zoomIdentity
                        .translate(centerX, centerY)
                        .scale(scale)
                        .translate(-midX, -midY)
                    );
            };

            performZoom(0);
        }
    }

    function updateTutorial() {
        const step = tutorialSteps[currentStep];

        // Storytelling: Update Graph Depth based on step
        if (currentStep === 0) updateGraphDepth(2);      // Intro: Full
        else if (currentStep === 1) updateGraphDepth(0); // Subject: Subject Only
        else if (currentStep === 2) updateGraphDepth(1); // Positions: Level 1
        else if (currentStep === 3) updateGraphDepth(2); // Arguments: Level 2
        else if (currentStep === 4) updateGraphDepth(2); // Clusters: Level 2
        else if (currentStep === 5) updateGraphDepth(3); // Keywords: Level 3
        else updateGraphDepth(3);

        let visualHTML = "";
        if (step.visual) {
            if (step.visual.trim().toLowerCase().endsWith(".svg")) {
                visualHTML = `<img src="${step.visual}" alt="Tutorial Visual">`;
            } else {
                visualHTML = step.visual;
            }
        }

        tutorialContent.innerHTML = `
        <h2>${step.title}</h2>
        <p>${step.text}</p>
        ${visualHTML ? `<div class="tutorial-visual">${visualHTML}</div>` : ''}
    `;

        updateStepper();
        applyTutorialFocus();

        // Gestione stato bottoni
        tutorialBack.disabled = currentStep === 0;
        tutorialNext.innerText = currentStep === tutorialSteps.length - 1 ? "Close" : "Next →";

        if (!tutorialSidebar.classList.contains('tutorial-closed')) {
            collapseInfoPanel();
            updateSimulationCenter(true);
        }
    }

    // Funzione centralizzata per chiudere il tutorial (usata da Next all'ultimo step e da Skip)
    function endTutorial() {
        tutorialSidebar.classList.add('tutorial-closed');
        tutorialToggle.style.display = "block";
        interactive = true;
        expandInfoPanel();
        resetHighlight();
        resetZoomToFit();
        updateSimulationCenter(true);
        updateGraphDepth(3); // Reset to full view
        depthNav.classList.remove('nav-hidden');
        // Mostra timeline
        const timelinePanel = document.getElementById("timeline-panel");
        if (timelinePanel) timelinePanel.classList.remove('nav-hidden');
        const searchPanel = document.getElementById("search-panel");
        if (searchPanel) searchPanel.classList.remove('nav-hidden');
        const minimapContainer = document.getElementById("minimap-container");
        if (minimapContainer) minimapContainer.classList.remove('nav-hidden');
        const suggestedViews = document.getElementById("suggested-views-container");
        if (suggestedViews) suggestedViews.classList.remove('nav-hidden');
        const resetViewContainer = document.getElementById("reset-view-container");
        if (resetViewContainer) resetViewContainer.classList.remove('nav-hidden');
        const exportViewContainer = document.getElementById("export-view-container");
        if (exportViewContainer) exportViewContainer.classList.remove('nav-hidden');
        const zoomInContainer = document.getElementById("zoom-in-container");
        if (zoomInContainer) zoomInContainer.classList.remove('nav-hidden');
        const zoomOutContainer = document.getElementById("zoom-out-container");
        if (zoomOutContainer) zoomOutContainer.classList.remove('nav-hidden');
        const themeToggleContainer = document.getElementById("theme-toggle-container");
        if (themeToggleContainer) themeToggleContainer.classList.remove('nav-hidden');
        const personalNotesContainer = document.getElementById("personal-notes-container");
        if (personalNotesContainer) personalNotesContainer.classList.remove('nav-hidden');
        alignLayout();
    }

    // Funzione per calcolare la distanza dinamica degli archi
    function getLinkDistance(d) {
        const sType = titleAccessor(d.source);
        const tType = titleAccessor(d.target);

        // 1. Cluster Internal (Coesione MASSIMA)
        if (sType === "CLUSTER" || tType === "CLUSTER") return 5;

        // 2. Entity Logic
        if (sType === "ENTITY" || tType === "ENTITY") {
            const ent = sType === "ENTITY" ? d.source : d.target;

            // A. Se Aperta (Testo visibile): Rilassa molto per dare spazio alle parole
            if (ent._open) return 100;

            // B. Se Chiusa (Rombo) E connessa a 1 solo nodo: Molto vicina
            if (ent.degree === 1) return 5;

            // C. Se Chiusa ma connessa a più nodi: Distanza standard (per non tirare troppo il grafo)
            return 5;
        }

        const rSource = getNodeVisualRadius(d.source || {});
        const rTarget = getNodeVisualRadius(d.target || {});

        // 3. Subject <-> Position (Distanza Semantica)
        // Avvicina le posizioni più "forti" (più argomenti), allontana quelle marginali.
        if ((sType === "SUBJECT" && tType === "POSITION") || (sType === "POSITION" && tType === "SUBJECT")) {
            const posNode = sType === "POSITION" ? d.source : d.target;
            const degree = posNode.degree || 0;
            
            // Formula: Base 160px - (15px * degree). Minimo 60px.
            const semanticSpacing = Math.max(1, 160 - (degree * 15));
            return semanticSpacing + rSource + rTarget;
        }

        // 4. lunghezza link arguments - positions
        return 60 + rSource + rTarget;
    }

    // Init
    initSimulation();

    // --- MINIMAP LOGIC ---
    const minimapSvg = d3.select("#minimap");
    const minimapScale = 0.1; // Fattore di scala per adattare il grafo alla minimappa

    // Gruppo contenitore per i nodi della minimappa
    const minimapContent = minimapSvg.append("g").attr("class", "minimap-content");
    
    // Rettangolo che rappresenta la vista corrente
    const minimapViewport = minimapSvg.append("rect")
        .attr("class", "minimap-viewport")
        .attr("fill", "none")
        .attr("stroke", "#9cc6e9")
        .attr("stroke-width", 0.001);

    // Crea i nodi semplificati nella minimappa
    const minimapNodes = minimapContent.selectAll("circle")
        .data(nodes)
        .enter()
        .append("circle")
        .attr("r", d => titleAccessorGlobal(d) === "SUBJECT" ? 3 : 1.5)
        .attr("fill", d => getNodeColor(d))
        .attr("opacity", 0.6);

    // Funzione per aggiornare il rettangolo della minimappa durante lo zoom
    updateMinimapViewport = function(t) {
        const mContainer = document.getElementById("minimap-container");
        const mWidth = mContainer ? mContainer.clientWidth : 160;
        const mHeight = minimapSvg.node() ? minimapSvg.node().getBoundingClientRect().height : mWidth;
        const subjectNode = globalNodes.find(n => titleAccessorGlobal(n) === "SUBJECT");
        const refX = subjectNode && subjectNode.x !== undefined ? subjectNode.x : width / 2;
        const refY = subjectNode && subjectNode.y !== undefined ? subjectNode.y : height / 2;

        // Calcola l'area visibile nel sistema di coordinate del grafo
        // x, y, w, h sono relativi allo spazio trasformato
        const vX = -t.x / t.k;
        const vY = -t.y / t.k;
        const vW = width / t.k;
        const vH = height / t.k;

        // Mappa le coordinate del grafo alle coordinate della minimappa
        // (0,0) del grafo -> centro della minimappa (80,80)
        const mapX = (val) => (val - refX) * minimapScale + mWidth / 2;
        const mapY = (val) => (val - refY) * minimapScale + mHeight / 2;

        const x_m = mapX(vX);
        const y_m = mapY(vY);
        const w_m = vW * minimapScale;
        const h_m = vH * minimapScale;

        minimapViewport
            .attr("x", x_m)
            .attr("y", y_m)
            .attr("width", w_m)
            .attr("height", h_m);
    };

    // --- RESET ZOOM TO FIT LOGIC ---
    function resetZoomToFit() {
        const nodesToFit = nodeGroup.selectAll(".node").data();
        if (nodesToFit.length === 0) return;

        const margin = 100;
        const bounds = {
            x0: d3.min(nodesToFit, d => d.x),
            x1: d3.max(nodesToFit, d => d.x),
            y0: d3.min(nodesToFit, d => d.y),
            y1: d3.max(nodesToFit, d => d.y)
        };

        const dx = bounds.x1 - bounds.x0;
        const dy = bounds.y1 - bounds.y0;
        const x = (bounds.x0 + bounds.x1) / 2;
        const y = (bounds.y0 + bounds.y1) / 2;

        const isSidebarOpen = !document.getElementById("tutorial-sidebar").classList.contains('tutorial-closed');
        const sidebarOffset = isSidebarOpen ? 360 : 0;
        const availableWidth = width - sidebarOffset;

        const scale = Math.min(2, 0.75 / Math.max(dx / availableWidth, dy / height));
        const translate = [sidebarOffset + availableWidth / 2 - scale * x, height / 2 - scale * y];

        svg.transition().duration(750).ease(d3.easeCubicInOut).call(
            zoom.transform,
            d3.zoomIdentity.translate(translate[0], translate[1]).scale(scale)
        );
    }

    const resetViewBtn = document.getElementById("reset-view-btn");
    if (resetViewBtn) {
        resetViewBtn.addEventListener("click", resetZoomToFit);
    }

    // --- ZOOM CONTROLS LOGIC ---
    const zoomInBtn = document.getElementById("zoom-in-btn");
    if (zoomInBtn) {
        zoomInBtn.addEventListener("click", () => {
            svg.transition().duration(300).call(zoom.scaleBy, 1.3);
        });
    }

    const zoomOutBtn = document.getElementById("zoom-out-btn");
    if (zoomOutBtn) {
        zoomOutBtn.addEventListener("click", () => {
            svg.transition().duration(300).call(zoom.scaleBy, 1 / 1.3);
        });
    }

    // --- EXPORT LOGIC ---
    const exportBtn = document.getElementById("export-view-btn");
    const exportMenu = document.getElementById("export-menu");
    
    if (exportBtn) {
        exportBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            exportMenu.classList.toggle("active");
        });
        document.addEventListener("click", () => exportMenu.classList.remove("active"));
    }

    // --- THEME TOGGLE LOGIC ---
    const themeSettingsBtn = document.getElementById("theme-settings-btn");

    if (themeSettingsBtn) {
        themeSettingsBtn.addEventListener("click", (e) => {
            document.body.classList.toggle("dark-mode");
            
            // Update eraser cursor if active to maintain visibility
            if (isDrawingMode && currentTool === 'eraser') {
                setDrawingTool('eraser');
            }
        });
    }

    window.exportGraph = function(type) {
        const svgEl = document.getElementById("graph");
        const serializer = new XMLSerializer();

        // 1. Calcola i confini di TUTTA la rete (non solo la vista corrente)
        const padding = 40;
        
        let xMin = Infinity;
        let yMin = Infinity;
        let xMax = -Infinity;
        let yMax = -Infinity;

        // A. NODI VISIBILI
        const visibleNodes = d3.selectAll("path.node").data();
        if (visibleNodes.length > 0) {
            xMin = d3.min(visibleNodes, d => d.x - getNodeVisualRadius(d));
            yMin = d3.min(visibleNodes, d => d.y - getNodeVisualRadius(d));
            xMax = d3.max(visibleNodes, d => d.x + getNodeVisualRadius(d));
            yMax = d3.max(visibleNodes, d => d.y + getNodeVisualRadius(d));
        }

        // B. POST-ITS
        d3.selectAll(".postit-object").each(function(d) {
            if (d) {
                if (d.x < xMin) xMin = d.x;
                if (d.y < yMin) yMin = d.y;
                if (d.x + d.width > xMax) xMax = d.x + d.width;
                if (d.y + d.height > yMax) yMax = d.y + d.height;
            }
        });

        // C. DISEGNI
        d3.selectAll(".drawing-path").each(function(d) {
            if (Array.isArray(d)) {
                d.forEach(p => {
                    if (p[0] < xMin) xMin = p[0];
                    if (p[1] < yMin) yMin = p[1];
                    if (p[0] > xMax) xMax = p[0];
                    if (p[1] > yMax) yMax = p[1];
                });
            }
        });

        // Fallback se non c'è nulla di visibile
        if (xMin === Infinity) {
            const nodesForBounds = globalNodes.filter(d => d.x !== undefined);
            if (nodesForBounds.length > 0) {
                xMin = d3.min(nodesForBounds, d => d.x - getNodeVisualRadius(d));
                yMin = d3.min(nodesForBounds, d => d.y - getNodeVisualRadius(d));
                xMax = d3.max(nodesForBounds, d => d.x + getNodeVisualRadius(d));
                yMax = d3.max(nodesForBounds, d => d.y + getNodeVisualRadius(d));
            } else {
                xMin = 0; yMin = 0; xMax = 100; yMax = 100;
            }
        }

        const bW = (xMax - xMin);
        const bH = (yMax - yMin);

        // 2. Prepara il clone dell'SVG
        const clone = svgEl.cloneNode(true);
        
        // Reset transform to ensure 1:1 export regardless of current zoom/pan
        const cloneG = clone.querySelector("g");
        if (cloneG) {
            cloneG.setAttribute("transform", "");
        }

        clone.setAttribute("viewBox", `${xMin - padding} ${yMin - padding} ${bW + padding * 2} ${bH + padding * 2}`);
        clone.setAttribute("width", bW + padding * 2);
        clone.setAttribute("height", bH + padding * 2);

        // CONVERSIONE POST-IT: Da HTML (foreignObject) a SVG puro per l'export
        // Questo evita il SecurityError (tainted canvas) e permette di vedere i post-it nel PNG/SVG
        const clonePostitGroup = clone.querySelector(".postits");
        if (clonePostitGroup) {
            clonePostitGroup.innerHTML = ""; // Pulisci i foreignObject clonati (che non funzionerebbero)

            // Itera sui post-it REALI nel DOM per prendere dati e testo
            document.querySelectorAll(".postit-object").forEach(realFo => {
                // Recupera i dati D3 associati all'elemento reale
                const d = d3.select(realFo).datum();
                if (!d) return;

                // Recupera il testo dalla textarea reale
                const textarea = realFo.querySelector("textarea");
                const textContent = textarea ? textarea.value : "";

                // Crea gruppo SVG
                const g = document.createElementNS("http://www.w3.org/2000/svg", "g");
                g.setAttribute("transform", `translate(${d.x}, ${d.y})`);

                // 1. Sfondo
                const rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
                rect.setAttribute("width", d.width);
                rect.setAttribute("height", d.height);
                rect.setAttribute("fill", "#FFE880");
                rect.setAttribute("stroke", "#F0DA78");
                rect.setAttribute("stroke-width", "1");
                g.appendChild(rect);

                // 2. Header
                const header = document.createElementNS("http://www.w3.org/2000/svg", "rect");
                header.setAttribute("width", d.width);
                header.setAttribute("height", 16);
                header.setAttribute("fill", "#F0DA78");
                g.appendChild(header);

                // 3. Testo (con wrapping manuale)
                const text = document.createElementNS("http://www.w3.org/2000/svg", "text");
                text.setAttribute("x", 8);
                text.setAttribute("y", 28);
                text.setAttribute("font-family", "sans-serif");
                text.setAttribute("font-size", "var(--fs-base)");
                text.setAttribute("fill", "#333");

                const charsPerLine = Math.floor((d.width - 16) / 7); // Stima caratteri per riga
                const paragraphs = textContent.split("\n");
                let dy = 0;

                paragraphs.forEach(para => {
                    const words = para.split(/\s+/);
                    let line = [];
                    
                    words.forEach(word => {
                        if ((line.join(" ") + " " + word).length > charsPerLine) {
                            const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
                            tspan.setAttribute("x", 8);
                            tspan.setAttribute("dy", dy === 0 ? 0 : 14);
                            tspan.textContent = line.join(" ");
                            text.appendChild(tspan);
                            line = [word];
                            dy += 14;
                        } else {
                            line.push(word);
                        }
                    });
                    // Flush last line of paragraph
                    const tspan = document.createElementNS("http://www.w3.org/2000/svg", "tspan");
                    tspan.setAttribute("x", 8);
                    tspan.setAttribute("dy", dy === 0 ? 0 : 14);
                    tspan.textContent = line.join(" ");
                    text.appendChild(tspan);
                    dy += 14;
                });

                g.appendChild(text);
                clonePostitGroup.appendChild(g);
            });
        }

        // CONVERSIONE DISEGNI: Da SVG a SVG (già vettoriale, ma assicuriamo stili)
        const cloneDrawingGroup = clone.querySelector(".drawings");
        if (cloneDrawingGroup) {
            // I disegni sono già path SVG, ma dobbiamo assicurarci che gli stili CSS siano applicati inline
            // o che la classe .drawing-path sia definita nello style block sotto.
            // Per sicurezza, iteriamo e applichiamo attributi espliciti.
            const realDrawings = document.querySelectorAll(".drawing-path");
            const cloneDrawings = cloneDrawingGroup.querySelectorAll(".drawing-path");
            
            cloneDrawings.forEach((path, i) => {
                const realPath = realDrawings[i];
                let stroke = realPath.getAttribute("stroke") || "var(--c-text-primary)";
                
                // Resolve CSS variable if present to ensure correct color in export
                if (stroke.includes("var(")) {
                    stroke = getComputedStyle(document.body).getPropertyValue('--c-text-primary').trim();
                }

                path.setAttribute("fill", "none");
                path.setAttribute("stroke", stroke);
                path.setAttribute("stroke-width", "3");
                path.setAttribute("stroke-linecap", "round");
                path.setAttribute("stroke-linejoin", "round");
            });
        }

        const resolvedLinkColor = getComputedStyle(document.documentElement).getPropertyValue('--c-link').trim() || "#bbb";
        const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--c-accent').trim() || "#007AFF";

        // 3. Iniezione stili espliciti (risolve il problema dei cerchi neri e variabili CSS)
        const style = document.createElement("style");
        style.textContent = `
            .node { stroke-width: 2px; }
            .link { stroke: ${resolvedLinkColor}; stroke-linecap: round; }
            .node-label { font-family: 'Inter', sans-serif; font-size: var(--fs-tiny); fill: #666; }
            .hull { stroke-width: 1px; fill-opacity: 0.25; }
            .selection-ring { 
                fill: none !important; 
                stroke: #007AFF !important; 
                stroke-width: 1.5px !important; 
                stroke-dasharray: 8, 4 !important; 
            }
            .postit-link-visual { 
                stroke: ${accentColor} !important; 
                stroke-width: 2px !important; 
                stroke-dasharray: 5, 3 !important; 
                fill: none !important;
            }
            /* Assicura che i colori dei nodi siano preservati */
            path[fill^="rgba"] { fill-opacity: 1; }
        `;
        clone.prepend(style);

        const svgData = serializer.serializeToString(clone);
        const fileName = `knowledge-graph-export`;

        if (type === 'svg') {
            const blob = new Blob([svgData], {type: "image/svg+xml;charset=utf-8"});
            const url = URL.createObjectURL(blob);
            download(url, `${fileName}.svg`);
        } else {
            // 4. Rendering ad alta risoluzione (2.5K)
            const exportWidth = 2560; 
            const aspectRatio = (bH + padding * 2) / (bW + padding * 2);
            const exportHeight = exportWidth * aspectRatio;

            const canvas = document.createElement("canvas");
            canvas.width = exportWidth;
            canvas.height = exportHeight;
            const ctx = canvas.getContext("2d");

            const img = new Image();
            const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
            const url = URL.createObjectURL(svgBlob);

            img.onload = () => {
                ctx.fillStyle = document.body.classList.contains("dark-mode") ? "#121212" : "#f8f8f8";
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, exportWidth, exportHeight);
                download(canvas.toDataURL("image/png", 1.0), `${fileName}.png`);
                URL.revokeObjectURL(url);
            };
            img.src = url;
        }
    };

    function download(url, name) {
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    }

    // Avvia il tutorial dopo che la simulazione ha fatto i primi calcoli
    setTimeout(() => {
        updateTutorial();
        interactive = false;
    }, 500); // Attendi 500ms (abbastanza per 30 tick a 60FPS)

    tutorialNext.addEventListener("click", () => {
        if (currentStep >= tutorialSteps.length - 1) {
            endTutorial();
        } else {
            currentStep++;
            updateTutorial();
        }
    });

    tutorialBack.addEventListener("click", () => {
        if (currentStep > 0) {
            currentStep--;
            updateTutorial();
        }
    });

    tutorialSkip.addEventListener("click", () => {
        endTutorial();
    });

    tutorialToggle.addEventListener("click", () => {
        tutorialSidebar.classList.remove('tutorial-closed');
        tutorialToggle.style.display = "none";
        interactive = false;
        depthNav.classList.add('nav-hidden'); // Nascondi navbar
        const timelinePanel = document.getElementById("timeline-panel");
        if (timelinePanel) timelinePanel.classList.add('nav-hidden'); // Nascondi timeline
        const searchPanel = document.getElementById("search-panel");
        if (searchPanel) searchPanel.classList.add('nav-hidden'); // Nascondi search
        const minimapContainer = document.getElementById("minimap-container");
        if (minimapContainer) minimapContainer.classList.add('nav-hidden'); // Nascondi minimap
        const suggestedViews = document.getElementById("suggested-views-container");
        if (suggestedViews) suggestedViews.classList.add('nav-hidden'); // Nascondi suggested views
        const resetViewContainer = document.getElementById("reset-view-container");
        if (resetViewContainer) resetViewContainer.classList.add('nav-hidden'); // Nascondi reset view
        const exportViewContainer = document.getElementById("export-view-container");
        if (exportViewContainer) exportViewContainer.classList.add('nav-hidden'); // Nascondi export
        const zoomInContainer = document.getElementById("zoom-in-container");
        if (zoomInContainer) zoomInContainer.classList.add('nav-hidden'); // Nascondi zoom in
        const zoomOutContainer = document.getElementById("zoom-out-container");
        if (zoomOutContainer) zoomOutContainer.classList.add('nav-hidden'); // Nascondi zoom out
        const themeToggleContainer = document.getElementById("theme-toggle-container");
        if (themeToggleContainer) themeToggleContainer.classList.add('nav-hidden'); // Nascondi theme toggle
        const personalNotesContainer = document.getElementById("personal-notes-container");
        if (personalNotesContainer) personalNotesContainer.classList.add('nav-hidden');
        
        currentStep = 0;
        updateTutorial();
        collapseInfoPanel();
        updateSimulationCenter(true);
        alignLayout();
    });

    // --- TIME PLAYER LOGIC ---
    const playBtn = document.getElementById("play-btn");
    const timeSlider = document.getElementById("time-slider");
    const dateDisplay = document.getElementById("time-date");
    
    // Create cursor element dynamically
    let timelineCursor = document.getElementById("timeline-cursor");
    if (!timelineCursor && timeSlider) {
        timelineCursor = document.createElement("div");
        timelineCursor.id = "timeline-cursor";
        timeSlider.parentNode.insertBefore(timelineCursor, timeSlider);
    }

    if (playBtn && timeSlider && dateDisplay) {
        // Configura slider con il dominio temporale
        if (timeDomain[0] !== timeDomain[1]) {
            timeSlider.min = timeDomain[0];
            timeSlider.max = timeDomain[1];
            timeSlider.value = timeDomain[1];
        } else {
            // Se non ci sono date, disabilita
            playBtn.disabled = true;
            timeSlider.disabled = true;
        }

        function formatTime(ts) {
            if (!ts || ts === 0) return "No Date";
            return new Date(ts).toLocaleString(undefined, { 
                year: 'numeric', 
                month: 'short', 
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            });
        }

        function updateTimeUI() {
            dateDisplay.innerText = formatTime(currentTime);
            timeSlider.value = currentTime;
            
            // Calculate percentage for progress bar and cursor
            const min = parseFloat(timeSlider.min);
            const max = parseFloat(timeSlider.max);
            const val = parseFloat(timeSlider.value);
            const ratio = (val - min) / (max - min);
            const percentage = ratio * 100;

            // Update Progress Bar (Background Gradient)
            timeSlider.style.background = `linear-gradient(to right, #007AFF 0%, #007AFF ${percentage}%, #e0e0e0 ${percentage}%, #e0e0e0 100%)`;

            // Update Cursor Position (Align with thumb center: 12px thumb width -> 6px offset)
            timelineCursor.style.display = "block";
            timelineCursor.style.left = `calc(${percentage}% + ${6 - 12 * ratio}px)`;
        }

        function setTime(ts) {
            isTimelineUpdate = true;
            currentTime = parseInt(ts);
            updateTimeUI();
            updateGraphDepth(currentDepthLevel, true); // Aggiorna visualizzazione con nuovo tempo
            isTimelineUpdate = false;
        }

        timeSlider.addEventListener("input", (e) => {
            setTime(e.target.value);
            if (isPlaying) stopPlay();
        });

        timeSlider.addEventListener("change", (e) => {
            setTime(e.target.value);
            if (isPlaying) stopPlay();
        });

        function startPlay() {
            // Se c'è un nodo selezionato specificamente, lo resettiamo per pulizia.
            // Ma se c'è un filtro attivo (Search o Suggested View) senza selezione nodo, lo manteniamo.
            if (selectedNodeData) {
                resetHighlight(); // Rimuove l'highlight del nodo selezionato
                selectedNodeData = null;
                if (selectionRing) selectionRing.style("opacity", 0);
                clearNodeDetails();
            }

            if (currentTime >= timeDomain[1]) currentTime = timeDomain[0]; // Riavvia se alla fine
            isPlaying = true;
            playBtn.innerHTML = `
                <svg viewBox="0 0 24 24" width="6" height="6" fill="currentColor">
                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"></path>
                </svg>
            `; // Pause icon

            const step = (timeDomain[1] - timeDomain[0]) / (animationDuration / 50); // step per 50ms interval

            playInterval = setInterval(() => {
                currentTime += step;
                if (currentTime >= timeDomain[1]) {
                    currentTime = timeDomain[1];
                    stopPlay();
                }
                setTime(currentTime);
            }, 50);
        }

        function stopPlay() {
            isPlaying = false;
            playBtn.innerHTML = `
                <svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor">
                    <path d="M5 3l14 9-14 9V3z"></path>
                </svg>
            `;
            clearInterval(playInterval);
        }

        playBtn.addEventListener("click", () => {
            if (isPlaying) stopPlay();
            else startPlay();
        });

        // Spacebar to toggle playback
        document.addEventListener("keydown", (e) => {
            if (!interactive) return; // Disable during tutorial
            
            const isTyping = document.activeElement.tagName === "INPUT" || 
                             document.activeElement.tagName === "TEXTAREA" ||
                             document.activeElement.isContentEditable;

            if (e.code === "Space" && !isTyping) {
                e.preventDefault(); // Prevent page scroll
                if (isPlaying) stopPlay();
                else startPlay();
            }
        });

        updateTimeUI(); // Mostra data iniziale
    }

    // --- TIMELINE ACTIVITY CHART ---
    // Disegna il grafico a "montagna" sopra lo slider
    function drawTimelineChart() {
        const container = document.getElementById("timeline-chart");
        if (!container || timeDomain[0] === timeDomain[1]) return;

        // Dimensioni contenitore
        const w = container.clientWidth;
        const h = container.clientHeight;

        // Pulisci eventuale SVG precedente
        container.innerHTML = "";

        const chartSvg = d3.select(container).append("svg")
            .attr("width", w)
            .attr("height", h)
            .attr("viewBox", `0 0 ${w} ${h}`)
            .attr("preserveAspectRatio", "none");

        // Crea i bin temporali (istogramma)
        const binGenerator = d3.bin()
            .value(d => d.timestamp)
            .domain(timeDomain)
            .thresholds(Math.floor(w / 8)); // Dynamic resolution: ~1 bin every 8px

        const bins = binGenerator(nodes.filter(n => n.timestamp));

        // Range padded by 6px to align perfectly with the slider thumb (12px width)
        const x = d3.scaleLinear().domain(timeDomain).range([6, w - 6]);
        const y = d3.scaleSqrt().domain([0, d3.max(bins, d => d.length)]).range([h, 2]); // ScaleSqrt rende visibili anche i singoli nodi

        // Prepare data for spline: use the midpoint of each bin
        // Add zero-points at start and end to ensure the area closes smoothly to the baseline
        const splineData = [
            { x: timeDomain[0], length: 0 },
            ...bins.map(b => {
                // Use mean timestamp for better alignment, fallback to midpoint if empty
                const xPos = b.length > 0 ? d3.mean(b, d => d.timestamp) : (b.x0 + b.x1) / 2;
                return { x: xPos, length: b.length };
            }),
            { x: timeDomain[1], length: 0 }
        ];

        const area = d3.area()
            .curve(d3.curveMonotoneX) // Smooth spline that preserves monotonicity
            .x(d => x(d.x))
            .y0(h)
            .y1(d => y(d.length));

        chartSvg.append("path")
            .datum(splineData)
            .attr("fill", "var(--c-accent)")
            .attr("fill-opacity", 0.3)
            .attr("stroke", "var(--c-accent)")
            .attr("stroke-width", 1.0)
            .attr("d", area);
    }

    // Disegna il grafico dopo aver calcolato il dominio temporale
    setTimeout(drawTimelineChart, 100);

    // --- SEARCH BAR LOGIC ---
    const searchInput = document.getElementById("search-input");
    if (searchInput) {
        searchInput.addEventListener("input", (e) => {
            const term = e.target.value.toLowerCase().trim();
            if (!term) {
                resetHighlight();
                return;
            }
            
            // Uncheck toggles if searching
            const tContested = document.getElementById("toggle-contested");
            const tLone = document.getElementById("toggle-lone");
            if (tContested) tContested.checked = false;
            if (tLone) tLone.checked = false;

            // Escape special regex characters to prevent errors
            const safeTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Use word boundary to avoid matching substrings inside words (e.g. "ai" in "available")
            const regex = new RegExp(`\\b${safeTerm}`, 'i');

            const filterFn = (d) => {
                const title = (d.detail__title || "");
                const text = (d.detail__text || "");
                const val = (d.detail__value || ""); // per le keyword
                const type = (titleAccessorGlobal(d) || "");
                
                // Cerca nel titolo, testo, valore (entity) o tipo
                return regex.test(title) || regex.test(text) || regex.test(val) || regex.test(type);
            };

            highlightNodes(filterFn);
        });
    }

    // --- SUGGESTED VIEWS LOGIC ---
    const toggleContested = document.getElementById("toggle-contested");
    const toggleLone = document.getElementById("toggle-lone");
    const toggleShared = document.getElementById("toggle-shared");

    function handleSuggestedView(viewType, isActive) {
        // Mutual exclusivity: Uncheck the other toggle
        if (viewType === 'contested' && isActive) {
            if (toggleLone) toggleLone.checked = false;
            if (toggleShared) toggleShared.checked = false;
        } else if (viewType === 'lone' && isActive) {
            if (toggleContested) toggleContested.checked = false;
            if (toggleShared) toggleShared.checked = false;
        } else if (viewType === 'shared' && isActive) {
            if (toggleContested) toggleContested.checked = false;
            if (toggleLone) toggleLone.checked = false;
        }

        if (!isActive) {
            resetHighlight();
            return;
        }

        let targetIds = new Set();

        if (viewType === 'contested') {
            // Find Position with max arguments (INFAVOR/AGAINST)
            let maxArgs = -1;
            let bestNode = null;

            nodes.forEach(n => {
                if (titleAccessorGlobal(n) === "POSITION") {
                    let count = 0;
                    globalEdges.forEach(e => {
                        const s = e.source.id || e.source;
                        const t = e.target.id || e.target;
                        const neighborId = (s === n.id) ? t : ((t === n.id) ? s : null);
                        
                        if (neighborId) {
                            const neighbor = nodeById.get(neighborId);
                            const type = titleAccessorGlobal(neighbor);
                            if (type === "INFAVOR" || type === "AGAINST") count++;
                        }
                    });

                    if (count > maxArgs) {
                        maxArgs = count;
                        bestNode = n;
                    }
                }
            });

            if (bestNode) {
                targetIds.add(bestNode.id);
                // Highlight connected arguments as well
                globalEdges.forEach(e => {
                    const s = e.source.id || e.source;
                    const t = e.target.id || e.target;
                    if (s === bestNode.id || t === bestNode.id) {
                         targetIds.add(s);
                         targetIds.add(t);
                    }
                });
            }

        } else if (viewType === 'shared') {
            // Trova tutte le Keywords (ENTITY) che collegano più di un contributo (ponte semantico globale)
            nodes.forEach(n => {
                if (titleAccessorGlobal(n) === "ENTITY" && (n.degree || 0) > 1) {
                    targetIds.add(n.id);
                    // Aggiungiamo i vicini per mostrare visivamente cosa viene collegato
                    globalEdges.forEach(e => {
                        const s = e.source.id || e.source;
                        const t = e.target.id || e.target;
                        if (s === n.id) targetIds.add(t);
                        if (t === n.id) targetIds.add(s);
                    });
                }
            });

        } else if (viewType === 'lone') {
             // Find Positions with NO arguments (only Subject connection)
             nodes.forEach(n => {
                if (titleAccessorGlobal(n) === "POSITION") {
                    // Check structural degree (connections to non-entities)
                    // If degree is 1, it's only connected to Subject (since it must be connected to something)
                    if (structuralDegree.get(n.id) <= 1) {
                        targetIds.add(n.id);
                    }
                }
            });
        }

        if (targetIds.size > 0) {
            highlightNodes(d => targetIds.has(d.id));
        }
    }

    if (toggleContested) {
        toggleContested.addEventListener("change", (e) => handleSuggestedView('contested', e.target.checked));
    }
    if (toggleLone) {
        toggleLone.addEventListener("change", (e) => handleSuggestedView('lone', e.target.checked));
    }
    if (toggleShared) {
        toggleShared.addEventListener("change", (e) => handleSuggestedView('shared', e.target.checked));
    }
    
    // --- POST-IT LOGIC ---
    const btnAddNote = document.getElementById("btn-add-note");
    const btnDraw = document.getElementById("btn-draw");
    const drawingToolbar = document.getElementById("drawing-toolbar");
    const btnDrawPencil = document.getElementById("draw-pencil");
    const btnDrawEraser = document.getElementById("draw-eraser");
    const btnDrawUndo = document.getElementById("draw-undo");
    const btnDrawTrash = document.getElementById("draw-trash");
    const btnDrawClose = document.getElementById("draw-close");

    let isAddingPostit = false;
    
    // Create Ghost Element
    const postitGhost = document.createElement("div");
    postitGhost.className = "postit-ghost";
    document.body.appendChild(postitGhost);

    function togglePostitMode(forceState) {
        isAddingPostit = forceState !== undefined ? forceState : !isAddingPostit;
        
        if (btnAddNote) {
            btnAddNote.classList.toggle("active", isAddingPostit);
        }

        if (isAddingPostit) {
            document.body.style.cursor = "crosshair";
        } else {
            document.body.style.cursor = "default";
            postitGhost.style.display = "none";
        }
    }

    if (btnAddNote) {
        btnAddNote.addEventListener("click", (e) => {
            e.stopPropagation(); // Prevent SVG click
            if (isDrawingMode) toggleDrawingMode(false);
            togglePostitMode();
        });
    }

    // --- DRAWING LOGIC ---
    let currentTool = 'pencil'; // 'pencil' or 'eraser'
    let drawingHistory = []; // Stack of path elements
    let currentPath = null;
    let currentDrawingColor = "var(--c-text-primary)"; // Default color

    // --- CREATE COLOR PALETTE DYNAMICALLY ---
    const paletteContainer = document.createElement("div");
    paletteContainer.id = "drawing-color-palette";
    document.body.appendChild(paletteContainer);

    const drawingColors = [
        { color: "var(--c-text-primary)", label: "Black" }, // Adaptive Black/White
        { color: "#db3a34", label: "Red" },
        { color: "#00cc66", label: "Green" },
        { color: "#007AFF", label: "Blue" }
    ];

    drawingColors.forEach((c, index) => {
        const swatch = document.createElement("div");
        swatch.className = "color-swatch";
        swatch.style.backgroundColor = c.color;
        swatch.title = c.label;
        
        if (index === 0) swatch.classList.add("active");

        swatch.addEventListener("click", (e) => {
            e.stopPropagation();
            currentDrawingColor = c.color;
            
            // Update UI
            document.querySelectorAll(".color-swatch").forEach(s => s.classList.remove("active"));
            swatch.classList.add("active");

            // If we click a color, ensure we are in pencil mode
            if (currentTool !== 'pencil') {
                setDrawingTool('pencil');
            }
        });

        paletteContainer.appendChild(swatch);
    });
    // ----------------------------------------

    function toggleDrawingMode(active) {
        isDrawingMode = active;
        
        if (active) {
            btnDraw.style.display = "none";
            drawingToolbar.style.display = "flex";
            setDrawingTool('pencil');
            document.body.style.cursor = "crosshair";
        } else {
            btnDraw.style.display = "flex";
            drawingToolbar.style.display = "none";
            document.body.style.cursor = "default";
            // Clear drawings on exit (Trash behavior)
            // clearDrawings(); // Removed: Close button just closes, doesn't clear automatically unless requested
            document.getElementById("drawing-color-palette").classList.remove("visible");
            if (drawingToolbar) drawingToolbar.classList.remove("palette-open");
        }
    }

    function setDrawingTool(tool) {
        currentTool = tool;
        // Update UI
        [btnDrawPencil, btnDrawEraser].forEach(btn => btn.classList.remove('active'));
        if (tool === 'pencil') btnDrawPencil.classList.add('active');
        if (tool === 'eraser') btnDrawEraser.classList.add('active');
        
        const palette = document.getElementById("drawing-color-palette");

        if (tool === 'pencil') {
            document.body.style.cursor = "crosshair";
            palette.classList.add("visible");
            if (drawingToolbar) drawingToolbar.classList.add("palette-open");
        } else if (tool === 'eraser') {
            const isDarkMode = document.body.classList.contains("dark-mode");
            const strokeColor = isDarkMode ? "white" : "black";
            document.body.style.cursor = `url('data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="none" stroke="${strokeColor}" stroke-width="2"/></svg>') 12 12, auto`;
            palette.classList.remove("visible");
            if (drawingToolbar) drawingToolbar.classList.remove("palette-open");
        }
    }

    function clearDrawings() {
        drawingGroup.selectAll("*").remove();
        drawingHistory = [];
    }

    function undoLastDrawing() {
        if (drawingHistory.length > 0) {
            const lastPath = drawingHistory.pop();
            lastPath.remove();
        }
    }

    if (btnDraw) {
        btnDraw.addEventListener("click", (e) => {
            e.stopPropagation();
            if (isAddingPostit) togglePostitMode(false);
            toggleDrawingMode(true);
        });
    }

    if (btnDrawPencil) btnDrawPencil.addEventListener("click", (e) => { e.stopPropagation(); setDrawingTool('pencil'); });
    if (btnDrawEraser) btnDrawEraser.addEventListener("click", (e) => { e.stopPropagation(); setDrawingTool('eraser'); });
    if (btnDrawUndo) btnDrawUndo.addEventListener("click", (e) => { e.stopPropagation(); undoLastDrawing(); });
    if (btnDrawTrash) btnDrawTrash.addEventListener("click", (e) => { e.stopPropagation(); clearDrawings(); });
    if (btnDrawClose) btnDrawClose.addEventListener("click", (e) => { e.stopPropagation(); toggleDrawingMode(false); });

    // SVG Drawing Events
    svg.on("mousedown.draw", function(event) {
        if (!isDrawingMode) return;

        // Stop simulation to prevent nodes from moving while drawing
        if (simulation) simulation.stop();

        const coords = d3.pointer(event, drawingGroup.node());

        if (currentTool === 'eraser') {
            eraseAt(coords);
            return;
        }

        if (currentTool === 'pencil') {
            const lineGenerator = d3.line().curve(d3.curveBasis);
            const points = [[coords[0], coords[1]]];

            currentPath = drawingGroup.append("path")
                .datum(points)
                .attr("class", "drawing-path")
                .attr("d", lineGenerator)
                .attr("stroke-width", 3)
                .attr("fill", "none")
                .attr("stroke", currentDrawingColor); // Use selected color
            
            drawingHistory.push(currentPath.node());
        }
    });

    svg.on("mousemove.draw", function(event) {
        if (!isDrawingMode) return;

        const coords = d3.pointer(event, drawingGroup.node());

        if (currentTool === 'eraser' && event.buttons === 1) {
            eraseAt(coords);
            return;
        }

        if (currentTool === 'pencil' && currentPath) {
            const points = currentPath.datum();
            points.push([coords[0], coords[1]]);
            
            const lineGenerator = d3.line().curve(d3.curveBasis);
            currentPath.attr("d", lineGenerator);
        }
    });

    svg.on("mouseup.draw", function() {
        currentPath = null;
    });

    function eraseAt(coords) {
        const transform = d3.zoomTransform(svg.node());
        const k = transform.k || 1;
        const eraserRadius = 12 / k; // Matches visual cursor area (~12px screen radius) adjusted for zoom
        const r2 = eraserRadius * eraserRadius;

        drawingGroup.selectAll(".drawing-path").each(function(d) {
            // d is array of points [[x,y], ...]
            // Check if any point of the stroke is within the eraser circle
            const hit = d.some(p => {
                const dx = p[0] - coords[0];
                const dy = p[1] - coords[1];
                return (dx * dx + dy * dy) < r2;
            });

            if (hit) {
                d3.select(this).remove();
                const idx = drawingHistory.indexOf(this);
                if (idx > -1) drawingHistory.splice(idx, 1);
            }
        });
    }

    document.addEventListener("mousemove", (e) => {
        if (!isAddingPostit) return;
        postitGhost.style.display = "block";
        // Offset slightly so it doesn't block the click
        postitGhost.style.left = (e.pageX + 15) + "px";
        postitGhost.style.top = (e.pageY + 15) + "px";
    });

    function createPostit(x, y) {
        const width = 140;
        const height = 100;
        
        // Data object for D3 binding
        const postitData = { x, y, width, height };

        const fo = postitGroup.append("foreignObject")
            .datum(postitData)
            .attr("x", x)
            .attr("y", y)
            .attr("width", width)
            .attr("height", height)
            .attr("class", "postit-object");

        const div = fo.append("xhtml:div")
            .attr("class", "postit-wrapper");
        
        // Selection logic
        div.on("mousedown", function() {
            d3.selectAll(".postit-wrapper").classed("selected", false);
            d3.select(this).classed("selected", true);
        });

        // Header
        const header = div.append("div").attr("class", "postit-header");
        
        // Close Button
        header.append("span")
            .attr("class", "postit-close")
            .text("✕")
            .on("click", function() {
                // Remove associated links
                postitLinksData = postitLinksData.filter(l => l.source !== postitData);
                postitLinkGroup.selectAll(".postit-link-group")
                    .data(postitLinksData)
                    .exit()
                    .remove();
                // Remove postit
                fo.remove();
            });

        // Content
        div.append("textarea")
            .attr("class", "postit-content")
            .attr("placeholder", "Write a note...")
            .attr("spellcheck", "false"); // Disable spellcheck underline

        // Resize Handles (Corners)
        const handles = ["nw", "ne", "sw", "se"];
        handles.forEach(pos => {
            div.append("div")
                .attr("class", `resize-handle rh-${pos}`)
                .call(d3.drag()
                    .on("start", function(event) {
                        const d = postitData;
                        d.startX = d.x;
                        d.startY = d.y;
                        d.startW = d.width;
                        d.startH = d.height;
                        // Cattura la posizione esatta del mouse nel sistema di coordinate del gruppo postit
                        const coords = d3.pointer(event, postitGroup.node());
                        d.pointerX = coords[0];
                        d.pointerY = coords[1];
                    })
                    .on("drag", function(event) {
                        const d = postitData;
                        const coords = d3.pointer(event, postitGroup.node());
                        const dx = coords[0] - d.pointerX;
                        const dy = coords[1] - d.pointerY;
                        
                        let newW = d.startW;
                        let newH = d.startH;
                        let newX = d.startX;
                        let newY = d.startY;
                        
                        if (pos.includes("e")) newW = Math.max(100, d.startW + dx);
                        if (pos.includes("w")) {
                            const proposedW = d.startW - dx;
                            newW = Math.max(100, proposedW);
                            newX = d.startX + (d.startW - newW);
                        }
                        if (pos.includes("s")) newH = Math.max(80, d.startH + dy);
                        if (pos.includes("n")) {
                            const proposedH = d.startH - dy;
                            newH = Math.max(80, proposedH);
                            newY = d.startY + (d.startH - newH);
                        }

                        // Update data
                        d.width = newW;
                        d.height = newH;
                        d.x = newX;
                        d.y = newY;

                        // Update DOM
                        fo.attr("width", newW).attr("height", newH)
                          .attr("x", newX).attr("y", newY);
                        simulation.alpha(0.01).restart(); // Update links while resizing
                    })
                );
        });

        // Link Handles (N, E, S, W)
        const linkHandles = ["n", "e", "s", "w"];
        let tempLinkLine = null;

        linkHandles.forEach(pos => {
            div.append("div")
                .attr("class", `link-handle lh-${pos}`)
                .on("mouseover", function(event) {
                    tooltip.style("opacity", 1).html(`<div style="font-family: var(--font-mono); font-size: var(--fs-tiny); text-transform: uppercase; color: var(--c-text-primary);">Drag to link</div>`);
                    moveTooltip(event);
                })
                .on("mousemove", moveTooltip)
                .on("mouseout", function() {
                    tooltip.style("opacity", 0);
                })
                .call(d3.drag()
                    .on("start", function(event) {
                        // Create temp line starting from the specific handle
                        const [sx, sy] = getHandleCoords(postitData, pos);
                        tempLinkLine = postitLinkGroup.append("line")
                            .attr("class", "temp-link")
                            .attr("x1", sx)
                            .attr("y1", sy)
                            .attr("x2", sx)
                            .attr("y2", sy);
                    })
                    .on("drag", function(event) {
                        // Update temp line to mouse position
                        // We need coordinates relative to the graph container 'g'
                        const coords = d3.pointer(event, g.node());
                        tempLinkLine.attr("x2", coords[0]).attr("y2", coords[1]);

                        // Hover Effect Logic
                        // 1. Hide temp line to not block hit test
                        tempLinkLine.style("display", "none");
                        // 2. Hide handle to not block hit test
                        d3.select(this).style("pointer-events", "none");

                        const el = document.elementFromPoint(event.sourceEvent.clientX, event.sourceEvent.clientY);
                        
                        // Restore visibility/events
                        tempLinkLine.style("display", "block");
                        d3.select(this).style("pointer-events", "all");

                        // Clear previous hover
                        d3.selectAll(".link-target-hover").classed("link-target-hover", false);

                        const d3Datum = d3.select(el).datum();
                        // Ensure we are hovering a Node or a Hull (ignore edges/lines)
                        const isNode = el.classList.contains("node");
                        const isHull = el.classList.contains("hull");
                        if ((isNode || isHull) && d3Datum && (d3Datum.id || titleAccessorGlobal(d3Datum) === "CLUSTER")) {
                            d3.select(el).classed("link-target-hover", true);
                        }
                    })
                    .on("end", function(event) {
                        // Remove temp line
                        if (tempLinkLine) tempLinkLine.remove();
                        tempLinkLine = null;
                        
                        // Clear hover effect
                        d3.selectAll(".link-target-hover").classed("link-target-hover", false);

                        // Hit test: what is under the mouse?
                        // We use the client coordinates from the source event
                        const clientX = event.sourceEvent.clientX;
                        const clientY = event.sourceEvent.clientY;
                        
                        // Temporarily hide the handle/postit so elementFromPoint sees below
                        const handle = d3.select(this);
                        handle.style("pointer-events", "none");
                        
                        const el = document.elementFromPoint(clientX, clientY);
                        
                        handle.style("pointer-events", "all"); // Restore

                        if (!el || el.tagName === 'line') return; // Ignore edges

                        // Check if we hit a Node or a Hull
                        const d3Datum = d3.select(el).datum();
                        const isNode = el.classList.contains("node");
                        const isHull = el.classList.contains("hull");
                        
                        if ((isNode || isHull) && d3Datum && (d3Datum.id || titleAccessorGlobal(d3Datum) === "CLUSTER")) {
                            // Create Link
                            postitLinksData.push({ source: postitData, target: d3Datum, handle: pos });
                            
                            const links = postitLinkGroup.selectAll(".postit-link-group")
                                .data(postitLinksData);
                            
                            const linksEnter = links.enter()
                                .append("g")
                                .attr("class", "postit-link-group");
                            
                            // Hit area (invisible, wide)
                            linksEnter.append("line")
                                .attr("class", "postit-link-hit")
                                .style("stroke", "transparent")
                                .style("stroke-width", "15px");

                            // Visual line
                            linksEnter.append("line")
                                .attr("class", "postit-link-visual");

                            linksEnter
                                .on("contextmenu", function(event, d) {
                                    event.preventDefault();
                                    // Remove link on right click
                                    postitLinksData = postitLinksData.filter(l => l !== d);
                                    d3.select(this).remove();
                                    tooltip.style("opacity", 0);
                                })
                                .on("mouseover", function(event) {
                                    tooltip.style("opacity", 1).html(`<div style="font-family: var(--font-mono); font-size: var(--fs-tiny); text-transform: uppercase; color: var(--c-text-primary);">Right-click to remove</div>`);
                                    moveTooltip(event);
                                })
                                .on("mousemove", moveTooltip)
                                .on("mouseout", function() {
                                    tooltip.style("opacity", 0);
                                });
                            
                            // Trigger tick to update positions immediately
                            simulation.alpha(0.01).restart();
                        }
                    })
                );
        });

        // Drag Behavior for the whole post-it (via header)
        header.call(d3.drag()
            .on("start", function(event) {
                // Select on drag start
                d3.selectAll(".postit-wrapper").classed("selected", false);
                div.classed("selected", true);

                const d = postitData;
                d.startX = d.x;
                d.startY = d.y;
                const coords = d3.pointer(event, postitGroup.node());
                d.pointerX = coords[0];
                d.pointerY = coords[1];
            })
            .on("drag", function(event) {
                const d = postitData;
                const coords = d3.pointer(event, postitGroup.node());
                d.x = d.startX + (coords[0] - d.pointerX);
                d.y = d.startY + (coords[1] - d.pointerY);
                fo.attr("x", d.x).attr("y", d.y);
                simulation.alpha(0.01).restart(); // Update links while dragging postit
            })
        );
        
        // Prevent zoom when interacting with post-it
        fo.on("mousedown", (e) => e.stopPropagation())
          .on("click", (e) => e.stopPropagation())
          .on("dblclick", (e) => e.stopPropagation());
    }
    
    // Escape key to cancel
    document.addEventListener("keydown", (e) => {
        if (e.key === "Escape" && isAddingPostit) {
            togglePostitMode(false);
        }
    });

    // --- LEGEND TOGGLE ---
    const legendToggleBtn = document.getElementById("legend-toggle-btn");
    const legendCard = document.getElementById("legend-card");
    
    if (legendToggleBtn && legendCard) {
        legendToggleBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            legendCard.classList.toggle("minimized");
        });
    }

    updateTutorial();
    alignLayout();

}).catch(error => {
    console.error("Error loading CSV files:", error);
    alert("Error loading KG_nodes.csv or KG_edges.csv. Check the filenames and paths.");
});
