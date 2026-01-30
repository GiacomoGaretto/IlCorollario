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
const nodeGroup = g.append("g").attr("class", "nodes");
const labelGroup = g.append("g").attr("class", "labels");
const postitGroup = g.append("g").attr("class", "postits"); // Layer for post-its
const drawingGroup = g.append("g").attr("class", "drawings").lower(); // Layer for drawings (below nodes/postits)

const zoom = d3.zoom()
    .scaleExtent([0.1, 4])
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

function alignSideButtons() {
    const minimap = document.getElementById("minimap-container");
    const btnIds = [
        "reset-view-container",
        "zoom-out-container",
        "zoom-in-container",
        "export-view-container",
        "theme-toggle-container"
    ];
    
    const buttons = btnIds.map(id => document.getElementById(id)).filter(el => el);
    if (!minimap || buttons.length < 2) return;

    // Usiamo getComputedStyle per ottenere i valori di layout "target" definiti nel CSS.
    // Questo ignora le trasformazioni temporanee (come il translateY di nav-hidden) e rispetta i margini reali.
    const mStyle = window.getComputedStyle(minimap);
    const mHeight = parseFloat(mStyle.height);
    const mBottom = parseFloat(mStyle.bottom); 
    
    // Align side controls to the right of minimap
    // Note: add-postit-container is manually positioned above suggested views, 
    // so we exclude it from this specific stack calculation if we want it separate, 
    // but if included in btnIds it will be stacked. 
    // Given the request "sopra le suggested-view", we should probably handle it separately 
    // or let CSS handle it. The CSS provided sets a fixed bottom for postit container.
    // Let's filter it out from this stack logic to respect the CSS position.
    const stackButtons = buttons;
    
    const mLeft = parseFloat(mStyle.left) + parseFloat(mStyle.width) + 10;

    const btnHeight = stackButtons[0].offsetHeight || 36; 
    const numButtons = stackButtons.length;

    stackButtons.forEach((btn, i) => {
        const posBottom = mBottom + (i * (mHeight - btnHeight) / (numButtons - 1));
        btn.style.bottom = `${posBottom}px`;
        btn.style.left = `${mLeft}px`;
    });
}

window.addEventListener("resize", () => {
    const container = document.getElementById("graph-container");
    if (!container) return;

    width = container.clientWidth;
    height = container.clientHeight;

    // Controllo di sicurezza: esegui solo se la simulazione è già stata inizializzata
    if (simulation && updateSimulationCenter) {
        const tutorialSidebar = document.getElementById("tutorial-sidebar");
        const tutorialOpen = tutorialSidebar && !tutorialSidebar.classList.contains('tutorial-closed');
        updateSimulationCenter(tutorialOpen);
    }
    alignSideButtons();
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
let titleAccessorGlobal;
let globalClusterMembers = new Map();
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

// --- HIGHLIGHT FUNCTIONS ---
function highlightNodes(filterFn) {
    // 1. Update NODI
    // Selezioniamo solo i path con classe .node, escludendo l'anello di selezione
    nodeGroup.selectAll("path.node").transition().duration(400)
        .attr("fill-opacity", d => (filterFn(d) ? 1 : 0.15))
        .attr("stroke-opacity", d => (filterFn(d) ? 1 : 0.1));

    // 2. Update LINK (La logica richiesta)
    linkGroup.selectAll("line").transition().duration(400)
        .attr("stroke", "#bbb") // Assicura che il colore sia sempre quello corretto
        .attr("stroke-opacity", d => {
            // Un link è attivo SOLO SE entrambi i nodi che connette sono attivi
            const isSourceActive = filterFn(d.source);
            const isTargetActive = filterFn(d.target);

            if (isSourceActive && isTargetActive) {
                // Se attivo, manteniamo la distinzione semantica AI (ENTITY) vs Umano
                const sType = titleAccessorGlobal(d.source);
                const tType = titleAccessorGlobal(d.target);
                return (sType === "ENTITY" || tType === "ENTITY") ? 0.4 : 0.8;
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
    nodeGroup.selectAll("path.node").transition().duration(400)
        .attr("fill-opacity", 1)
        .attr("stroke-opacity", 1);

    linkGroup.selectAll("line").transition().duration(400)
        .attr("stroke", "#bbb") // Uniforma il colore al reset
        .attr("stroke-opacity", d => {
            const sType = titleAccessorGlobal(d.source);
            const tType = titleAccessorGlobal(d.target);
            // Torna all'opacità di default: 0.25 per AI, 0.6 per Umano
            return (sType === "ENTITY" || tType === "ENTITY") ? 0.25 : 0.6;
        });

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

    titleAccessorGlobal = d => d.title || d.detail__title || "Untitled";
    const titleAccessor = titleAccessorGlobal;

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
                .style("font-size", "11px")
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

    function getHullPath(clusterNode) {
        const allMembers = clusterMembers.get(clusterNode.id) || [];
        const visibleMembers = allMembers.filter(m => titleAccessor(m) !== "CLUSTER");

        if (visibleMembers.length === 0) return "";

        const points = [];
        visibleMembers.forEach(m => {
            if (!m.x || !m.y) return;
            const r = getNodeVisualRadius(m) + hullPadding;
            points.push([m.x - r, m.y]);
            points.push([m.x + r, m.y]);
            points.push([m.x, m.y - r]);
            points.push([m.x, m.y + r]);
        });

        const hullPoints = d3.polygonHull(points);
        return hullPoints ? curve(hullPoints) : "";
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
        .attr("stroke", "#bbb")
        // Spessore differenziato
        .attr("stroke-width", d => {
            const sType = titleAccessorGlobal(nodeById.get(d.source.id || d.source));
            const tType = titleAccessorGlobal(nodeById.get(d.target.id || d.target));
            return (sType === "ENTITY" || tType === "ENTITY") ? 1.2 : 1.2;
        })
        // TRATTEGGIO: Solo per le Keywords (ENTITY)
        .style("stroke-dasharray", d => {
            const sType = titleAccessorGlobal(nodeById.get(d.source.id || d.source));
            const tType = titleAccessorGlobal(nodeById.get(d.target.id || d.target));
            return (sType === "ENTITY" || tType === "ENTITY") ? "4,3" : "none";
        })
        // Opacità ridotta per le connessioni AI
        .attr("stroke-opacity", d => {
            const sType = titleAccessorGlobal(nodeById.get(d.source.id || d.source));
            const tType = titleAccessorGlobal(nodeById.get(d.target.id || d.target));
            return (sType === "ENTITY" || tType === "ENTITY") ? 0.25 : 0.6;
        });

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
            const alpha = isTimelineUpdate ? 0.1 : 0.3;
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
        const shouldStagger = isTimelineUpdate && !isTutorialOpen;

        const enterSize = nodeEnter.size();
        const staggerDelay = shouldStagger ? (enterSize > 50 ? 5 : 10) : 0;

        nodeEnter.transition()
            .duration(0)
            .delay((d, i) => i * staggerDelay)
            .attr("opacity", d => titleAccessorGlobal(d) === "CLUSTER" ? 0 : 1);

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
            .attr("opacity", 1);

        // Rebind dei link
        const linkSelection = linkGroup.selectAll("line").data(renderEdges, d => `${d.source.id || d.source}-${d.target.id || d.target}`);
        linkSelection.exit().remove();
        linkSelection.enter()
            .append("line")
            .attr("class", "link")
            .attr("stroke", "#bbb")
            .attr("stroke-width", d => {
                const sType = titleAccessorGlobal(globalNodes.find(n => n.id === (d.source.id || d.source)));
                const tType = titleAccessorGlobal(globalNodes.find(n => n.id === (d.target.id || d.target)));
                return (sType === "ENTITY" || tType === "ENTITY") ? 1.2 : 1.2;
            })
            .style("stroke-dasharray", d => {
                const sType = titleAccessorGlobal(globalNodes.find(n => n.id === (d.source.id || d.source)));
                const tType = titleAccessorGlobal(globalNodes.find(n => n.id === (d.target.id || d.target)));
                return (sType === "ENTITY" || tType === "ENTITY") ? "4,3" : "none";
            })
            .attr("stroke-opacity", 0)
            .transition()
            .duration(0)
            .delay((d, i) => i * staggerDelay)
            .attr("stroke-opacity", d => {
                const sType = titleAccessorGlobal(globalNodes.find(n => n.id === (d.source.id || d.source)));
                const tType = titleAccessorGlobal(globalNodes.find(n => n.id === (d.target.id || d.target)));
                return (sType === "ENTITY" || tType === "ENTITY") ? 0.25 : 0.6;
            });

        // Aggiorna hulls
        const hullData = visibleNodes.filter(d => titleAccessorGlobal(d) === "CLUSTER");
        const hullSelection = hullGroup.selectAll("path").data(hullData, d => d.id);
        hullSelection.exit().remove();
        
        const hullOpacity = d => {
            const members = globalClusterMembers.get(d.id) || [];
            // La hull compare solo quando TUTTI i nodi che contiene sono comparsi nella timeline
            const allMembersAppeared = members.every(m => !m.timestamp || m.timestamp <= currentTime);
            return allMembersAppeared ? 1 : 0;
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
            .attr("fill-opacity", 0.25)
            .attr("stroke-opacity", 0.75)
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
                    if (d.mainStat === "HAS_POSITION") return 0.7;
                    if (d.mainStat === "MENTION") return 0.2;
                    return 0.4;
                })
            )
            // Repulsione (Charge) bilanciata per gerarchia
            .force("charge", d3.forceManyBody()
                .strength(d => {
                    const type = titleAccessorGlobal(d);
                    if (type === "SUBJECT") return -1000; // Il centro spinge per farsi spazio
                    if (type === "ENTITY") return -50;    // Le keyword non disturbano la struttura
                    return -300; // Posizioni e Argomenti hanno una repulsione media
                })
                .distanceMax(500)
            )
            // Forza centripeta differenziata (mantiene il Soggetto al centro)
            .force("x", d3.forceX(width / 2).strength(d => titleAccessorGlobal(d) === "SUBJECT" ? 0.5 : 0.05))
            .force("y", d3.forceY(height / 2).strength(d => titleAccessorGlobal(d) === "SUBJECT" ? 0.5 : 0.05))
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
        simulation.force("x", d3.forceX(cx).strength(d => titleAccessorGlobal(d) === "SUBJECT" ? 0.5 : 0.05));
        simulation.force("y", d3.forceY(cy).strength(d => titleAccessorGlobal(d) === "SUBJECT" ? 0.5 : 0.05));
        simulation.alpha(0.5).restart();
    };

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
        else if (alpha > 0.03) hullModulo = 8; // Movimento rallentato: ogni 8 tick
        else hullModulo = 24;                 // Quasi statico: ogni 24 tick

        if (tickCount % hullModulo === 0 || alpha <= simulation.alphaMin() + 0.001) {
            hulls.attr("d", d => getHullPath(d));
        }

        // Aggiorna nodi Minimappa
        const mContainer = document.getElementById("minimap-container");
        const mSize = mContainer ? mContainer.clientWidth : 160;
        const subjectNode = globalNodes.find(n => titleAccessorGlobal(n) === "SUBJECT");
        const refX = subjectNode && subjectNode.x !== undefined ? subjectNode.x : width / 2;
        const refY = subjectNode && subjectNode.y !== undefined ? subjectNode.y : height / 2;

        minimapNodes
            .attr("cx", d => (d.x - refX) * minimapScale + mSize / 2)
            .attr("cy", d => (d.y - refY) * minimapScale + mSize / 2);
        
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
        const title = d.detail__title || "";
        let type = d.mainStat || titleAccessor(d) || "unknown";
        if (type === "ENTITY") type = "KEYWORD";
        const sub = d.subStat || "";
        const text = d.detail__text || "";

        const titleHTML = title ? `<strong>${escapeHTML(title)}</strong><br/>` : "";

        return `
            ${titleHTML}
            <div style="font-family: var(--font-mono); font-size: var(--fs-small); text-transform: uppercase; margin-bottom: 4px; color: var(--color-primary);">${escapeHTML(type)}${sub ? " · " + escapeHTML(sub) : ""}</div>
            <div style="font-size: 11px; margin-bottom: 8px; line-height: 1.4;">${escapeHTML(truncate(text, 140))}</div>
            <div style="font-family: var(--font-mono); font-size: 9px; text-transform: uppercase; opacity: 0.6; border-top: 1px solid rgba(255,255,255,0.1); padding-top: 4px;">Click for details</div>
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
        let nodeType = titleAccessorGlobal(d);
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

        const displayTitle = (titleAccessorGlobal(d) === "CLUSTER") ?
            (d.detail__tagline || d.detail__title || "") :
            (d.detail__title || "");

        const displayText = (titleAccessorGlobal(d) === "CLUSTER") ?
            (d.detail__summary || d.detail__text || "") :
            (d.detail__text || "");

        d3.select("#node-title").text(displayTitle);
        const textContainer = d3.select("#node-text");
        textContainer.text(displayText);

        const nodeValueContainer = d3.select("#node-value");
        nodeValueContainer.html("");

        if (titleAccessorGlobal(d) === "POSITION") {
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
                        <span style="font-family: var(--font-mono); font-size: 18px; font-weight: var(--fw-bold); color: ${color};">${count}</span>
                    </div>`;
            };

            let html = `<div style="display: flex; gap: 10px; width: 100%;">`;
            html += createPill(pro, "INFAVOUR", colorMap["INFAVOR"]);
            html += createPill(con, "AGAINST", colorMap["AGAINST"]);
            html += `</div>`;
            nodeValueContainer.html(html);

        } else if (titleAccessorGlobal(d) === "CLUSTER") {
            const allMems = globalClusterMembers.get(d.id) || [];
            const visMems = allMems.filter(m => titleAccessorGlobal(m) !== "CLUSTER");
            nodeValueContainer.text(`This area groups ${visMems.length} connected argument(s).`);
        } else {
            let stats = "";
            if (d.detail__value && d.detail__value !== "") {
                stats = `Value: ${String(d.detail__value).replace(/['"]+/g, '')}`;
            }
            nodeValueContainer.text(stats);
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

        const margin = 80;

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

        svg.transition().duration(800).call(zoom.transform, transform);
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
                if (type === "ENTITY") return t === "ENTITY";
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
                filterFn = n => targetIds.has(n.id) || titleAccessorGlobal(n) === "SUBJECT" || titleAccessorGlobal(n) === "POSITION";
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
        if (currentStep === 0) updateGraphDepth(3);      // Intro: Full
        else if (currentStep === 1) updateGraphDepth(0); // Subject: Subject Only
        else if (currentStep === 2) updateGraphDepth(1); // Positions: Level 1
        else if (currentStep === 3) updateGraphDepth(2); // Arguments: Level 2
        else if (currentStep === 4) updateGraphDepth(2); // Clusters: Level 2
        else if (currentStep === 5) updateGraphDepth(3); // Keywords: Level 3
        else updateGraphDepth(3);

        tutorialContent.innerHTML = `
        <h2>${step.title}</h2>
        <p>${step.text}</p>
        <div class="tutorial-visual">
            ${step.visual}
        </div>
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
        resetZoom();
        updateSimulationCenter(false);
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
        alignSideButtons();
    }

    // Funzione per calcolare la distanza dinamica degli archi
    function getLinkDistance(d) {
        const sType = titleAccessor(d.source);
        const tType = titleAccessor(d.target);

        // 1. Cluster Internal (Coesione MASSIMA)
        if (sType === "CLUSTER" || tType === "CLUSTER") return 15;

        // 2. Entity Logic
        if (sType === "ENTITY" || tType === "ENTITY") {
            const ent = sType === "ENTITY" ? d.source : d.target;

            // A. Se Aperta (Testo visibile): Rilassa molto per dare spazio alle parole
            if (ent._open) return 100;

            // B. Se Chiusa (Rombo) E connessa a 1 solo nodo: Molto vicina
            if (ent.degree === 1) return 1;

            // C. Se Chiusa ma connessa a più nodi: Distanza standard (per non tirare troppo il grafo)
            return 35;
        }

        const rSource = getNodeVisualRadius(d.source || {});
        const rTarget = getNodeVisualRadius(d.target || {});

        // 3. Subject <-> Position (Distanza Semantica)
        // Avvicina le posizioni più "forti" (più argomenti), allontana quelle marginali.
        if ((sType === "SUBJECT" && tType === "POSITION") || (sType === "POSITION" && tType === "SUBJECT")) {
            const posNode = sType === "POSITION" ? d.source : d.target;
            const degree = posNode.degree || 0;
            
            // Formula: Base 180px - (12px * degree). Minimo 60px.
            const semanticSpacing = Math.max(60, 160 - (degree * 15));
            return semanticSpacing + rSource + rTarget;
        }

        // 4. Struttura Gerarchica Standard (Fallback)
        return 100 + rSource + rTarget;
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
        const mSize = mContainer ? mContainer.clientWidth : 160;
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
        const mapX = (val) => (val - refX) * minimapScale + mSize / 2;
        const mapY = (val) => (val - refY) * minimapScale + mSize / 2;

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
    const themeSwitchWrapper = document.getElementById("theme-switch-wrapper");
    const darkModeToggle = document.getElementById("dark-mode-toggle");

    if (themeSettingsBtn && themeSwitchWrapper) {
        themeSettingsBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            themeSwitchWrapper.classList.toggle("active");
        });
        document.addEventListener("click", () => themeSwitchWrapper.classList.remove("active"));
        themeSwitchWrapper.addEventListener("click", (e) => e.stopPropagation());
    }

    if (darkModeToggle) {
        darkModeToggle.addEventListener("change", (e) => {
            if (e.target.checked) {
                document.body.classList.add("dark-mode");
            } else {
                document.body.classList.remove("dark-mode");
            }
        });
    }

    window.exportGraph = function(type) {
        const svgEl = document.getElementById("graph");
        const serializer = new XMLSerializer();

        // 1. Calcola i confini di TUTTA la rete (non solo la vista corrente)
        const padding = 60;
        const nodesForBounds = globalNodes.filter(d => d.x !== undefined);
        if (nodesForBounds.length === 0) return;

        const xMin = d3.min(nodesForBounds, d => d.x - 50);
        const yMin = d3.min(nodesForBounds, d => d.y - 50);
        const xMax = d3.max(nodesForBounds, d => d.x + 50);
        const yMax = d3.max(nodesForBounds, d => d.y + 50);
        
        const bW = (xMax - xMin) || 100;
        const bH = (yMax - yMin) || 100;

        // 2. Prepara il clone dell'SVG
        const clone = svgEl.cloneNode(true);
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
                text.setAttribute("font-size", "12");
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
            
            const isDarkMode = document.body.classList.contains("dark-mode");
            const strokeColor = isDarkMode ? "#e0e0e0" : "#1a1a1a";

            cloneDrawings.forEach((path, i) => {
                path.setAttribute("fill", "none");
                path.setAttribute("stroke", strokeColor);
                path.setAttribute("stroke-width", "2");
                path.setAttribute("stroke-linecap", "round");
                path.setAttribute("stroke-linejoin", "round");
            });
        }

        // 3. Iniezione stili espliciti (risolve il problema dei cerchi neri e variabili CSS)
        const style = document.createElement("style");
        style.textContent = `
            .node { stroke-width: 2px; }
            .link { stroke: #bbb; stroke-linecap: round; }
            .node-label { font-family: 'Inter', sans-serif; font-size: 10px; fill: #666; }
            .hull { stroke-width: 1px; fill-opacity: 0.25; }
            .selection-ring { 
                fill: none !important; 
                stroke: #007AFF !important; 
                stroke-width: 1.5px !important; 
                stroke-dasharray: 8, 4 !important; 
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
        alignSideButtons();
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
            return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
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

        function startPlay() {
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
            .thresholds(40); // Numero di intervalli

        const bins = binGenerator(nodes.filter(n => n.timestamp));

        // Range padded by 6px to align perfectly with the slider thumb (12px width)
        const x = d3.scaleLinear().domain(timeDomain).range([6, w - 6]);
        const y = d3.scaleSqrt().domain([0, d3.max(bins, d => d.length)]).range([h, 2]); // ScaleSqrt rende visibili anche i singoli nodi

        // Per un look a step tecnico, aggiungiamo un punto finale fittizio per chiudere il grafico a zero
        const stepData = [...bins, { x0: bins[bins.length - 1].x1, length: 0 }];

        const area = d3.area()
            .curve(d3.curveStepAfter) // Trasforma la curva in gradini tecnici
            .x(d => x(d.x0)) // Allinea l'inizio dello step al timestamp corretto
            .y0(h)
            .y1(d => y(d.length));

        chartSvg.append("path")
            .datum(stepData)
            .attr("fill", "#007bff93") // Colore d'accento (Blu Elettrico)
            .attr("d", area)
            .attr("opacity", 1);
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

            const filterFn = (d) => {
                const title = (d.detail__title || "").toLowerCase();
                const text = (d.detail__text || "").toLowerCase();
                const val = (d.detail__value || "").toLowerCase(); // per le keyword
                const type = (titleAccessorGlobal(d) || "").toLowerCase();
                
                // Cerca nel titolo, testo, valore (entity) o tipo
                return title.includes(term) || text.includes(term) || val.includes(term) || type.includes(term);
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
            togglePostitMode();
        });
    }

    // --- DRAWING LOGIC ---
    let currentTool = 'pencil'; // 'pencil' or 'eraser'
    let drawingHistory = []; // Stack of path elements
    let currentPath = null;

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
        }
    }

    function setDrawingTool(tool) {
        currentTool = tool;
        // Update UI
        [btnDrawPencil, btnDrawEraser].forEach(btn => btn.classList.remove('active'));
        if (tool === 'pencil') btnDrawPencil.classList.add('active');
        if (tool === 'eraser') btnDrawEraser.classList.add('active');
        
        if (tool === 'pencil') {
            document.body.style.cursor = "crosshair";
        } else if (tool === 'eraser') {
            document.body.style.cursor = "url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"24\" height=\"24\" viewBox=\"0 0 24 24\"><circle cx=\"12\" cy=\"12\" r=\"10\" fill=\"none\" stroke=\"black\" stroke-width=\"2\"/></svg>') 12 12, auto";
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
                .attr("fill", "none");
            
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

        // Header
        const header = div.append("div").attr("class", "postit-header");
        
        // Close Button
        header.append("span")
            .attr("class", "postit-close")
            .text("✕")
            .on("click", function() {
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
                    })
                );
        });

        // Drag Behavior for the whole post-it (via header)
        header.call(d3.drag()
            .on("start", function(event) {
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
            })
        );
        
        // Prevent zoom when interacting with post-it
        fo.on("mousedown", (e) => e.stopPropagation())
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
    alignSideButtons();

}).catch(error => {
    console.error("Error loading CSV files:", error);
    alert("Error loading KG_nodes.csv or KG_edges.csv. Check the filenames and paths.");
});
