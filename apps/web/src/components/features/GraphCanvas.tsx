import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { DataSet, Network } from 'vis-network/standalone';
import type { Options, DataSetNodes, DataSetEdges, Node, Edge, IdType } from 'vis-network/standalone';
import { Play, Pause, Maximize2 } from 'lucide-react';
import type { GraphExport, GraphNode } from '@/services/api';

interface GraphCanvasProps {
  data: GraphExport;
  /** Altura del contenedor. */
  height?: string;
  /** Callback sobre un click de nodo; por defecto navega a /image/<id> o /tag/<label>. */
  onNodeClick?: (node: GraphNode) => void;
}

const NODE_NEIGHBOR_RING = '#fbbf24'; // ámbar (vecinos)
const NODE_SELECTED_RING = '#ffffff'; // blanco (seleccionado)
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5)); // distribución tipo girasol

/** Mezcla dos colores hex; t=0 devuelve a, t=1 devuelve b. */
function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  const out = pa.map((v, i) => Math.round(v + (pb[i] - v) * t));
  return `#${out.map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Genera una esfera con degradado radial (luz arriba-izquierda, sombra en el
 * canto) como SVG en data URI. Es lo que reemplaza el círculo plano "de Paint".
 */
function sphereIcon(color: string, ring?: string): string {
  const light = mix(color, '#ffffff', 0.62);
  const dark = mix(color, '#000000', 0.45);
  const ringSvg = ring
    ? `<circle cx="64" cy="64" r="58" fill="none" stroke="${ring}" stroke-width="6"/>`
    : '';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">` +
    `<defs>` +
    `<radialGradient id="base" cx="36%" cy="30%" r="72%">` +
    `<stop offset="0%" stop-color="${light}"/>` +
    `<stop offset="52%" stop-color="${color}"/>` +
    `<stop offset="100%" stop-color="${dark}"/>` +
    `</radialGradient>` +
    `<radialGradient id="gloss" cx="40%" cy="34%" r="42%">` +
    `<stop offset="0%" stop-color="#ffffff" stop-opacity="0.55"/>` +
    `<stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>` +
    `</radialGradient>` +
    `</defs>` +
    `<circle cx="64" cy="64" r="62" fill="url(#base)"/>` +
    ringSvg +
    `<circle cx="64" cy="64" r="62" fill="url(#gloss)"/>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Color apagado para los nodos no relacionados con la selección. */
function mute(color: string): string {
  return mix(color, '#475569', 0.7);
}

/**
 * Organización por racimos (sin rejilla): cada comunidad se distribuye como un
 * "cardumen" alrededor de un centro, y los centros se reparten en espiral
 * (girasol) según el tamaño del grupo. Determinista y sin solapamiento.
 */
function computeLayout(nodes: GraphNode[]): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  if (nodes.length === 0) return positions;

  const groups = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    const key =
      n.type === 'community'
        ? `c:${n.id}`
        : n.meta?.community !== undefined
          ? `c:${n.meta.community}`
          : `t:${n.type}`;
    const list = groups.get(key);
    if (list) list.push(n);
    else groups.set(key, [n]);
  }

  const entries = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  const single = entries.length === 1;

  const clusterRadius = (count: number) =>
    single ? 60 + 30 * Math.sqrt(count) : Math.min(240, 46 + 24 * Math.sqrt(count));

  const maxR = Math.max(...entries.map(([, list]) => clusterRadius(list.length)));
  const step = single ? 0 : maxR * 1.7 + 60;

  entries.forEach(([, list], gi) => {
    // Centro del racimo en espiral de girasol (ni filas ni columnas).
    const centerAngle = gi * GOLDEN_ANGLE;
    const centerDist = step * Math.sqrt(gi);
    const cx = Math.cos(centerAngle) * centerDist;
    const cy = Math.sin(centerAngle) * centerDist;
    const r = clusterRadius(list.length);

    list.forEach((n, i) => {
      if (list.length === 1) {
        positions.set(n.id, { x: cx, y: cy });
        return;
      }
      const angle = i * GOLDEN_ANGLE;
      const radius = r * Math.sqrt((i + 0.5) / list.length);
      positions.set(n.id, {
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      });
    });
  });

  return positions;
}

/** Tooltip HTML con la información precisa del nodo. */
function nodeTitle(n: GraphNode): string {
  if (n.type === 'community') {
    const parts = [`<b>Grupo ${n.meta?.community ?? ''}</b>`];
    if (n.meta?.size) parts.push(`${n.meta.size.toLocaleString('es')} imágenes`);
    if (n.meta?.topTags?.length) parts.push(`Tags: ${n.meta.topTags.slice(0, 5).join(', ')}`);
    if (n.meta?.style) parts.push(`Estilo: ${n.meta.style}`);
    if (n.meta?.mood) parts.push(`Mood: ${n.meta.mood}`);
    return parts.join('<br>');
  }
  const parts = [`<b>${n.label}</b>`];
  if (n.meta?.topTags?.length) parts.push(n.meta.topTags.slice(0, 5).join(', '));
  if (n.meta?.style) parts.push(`Estilo: ${n.meta.style}`);
  if (n.meta?.mood) parts.push(`Mood: ${n.meta.mood}`);
  return parts.join('<br>');
}

/**
 * Renderiza un grafo con vis-network. Organización por racimos de comunidad,
 * burbujas con volumen y layout estable (física apagada por defecto).
 */
export function GraphCanvas({ data, height = '70vh', onNodeClick }: GraphCanvasProps) {
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const networkRef = useRef<Network | null>(null);
  const baseColor = useRef<Map<string, string>>(new Map());
  const baseSize = useRef<Map<string, number>>(new Map());

  // El callback vive en un ref: si formara parte de las deps del efecto, cada
  // render del padre reconstruiría el network (y reiniciaría la física).
  const onNodeClickRef = useRef(onNodeClick);
  onNodeClickRef.current = onNodeClick;

  const [physicsOn, setPhysicsOn] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    if (networkRef.current) {
      networkRef.current.destroy();
      networkRef.current = null;
    }
    baseColor.current = new Map();
    baseSize.current = new Map();

    if (data.nodes.length === 0) return;

    const positions = computeLayout(data.nodes);
    // Con muchas imágenes, las etiquetas saturan: se muestran en el tooltip.
    const showLabels = (node: GraphNode) =>
      node.type !== 'image' || data.nodes.length <= 30;

    const nodes: Node[] = data.nodes.map((node) => {
      const radius = Math.max(9, Math.min(38, node.size + 8));
      baseColor.current.set(node.id, node.color);
      baseSize.current.set(node.id, radius);
      const pos = positions.get(node.id);
      return {
        id: node.id,
        label: showLabels(node) ? node.label : undefined,
        shape: 'circularImage',
        image: sphereIcon(node.color),
        size: radius,
        borderWidth: 0,
        color: { border: 'transparent' },
        title: nodeTitle(node),
        x: pos?.x,
        y: pos?.y,
      };
    });

    const edges: Edge[] = data.edges.map((edge) => ({
      from: edge.source,
      to: edge.target,
      width: Math.max(1, Math.min(4, edge.weight * 0.35)),
      color: { color: 'rgba(100,116,139,0.3)', highlight: NODE_NEIGHBOR_RING },
    }));

    const nodesDataSet: DataSetNodes = new DataSet(nodes);
    const edgesDataSet: DataSetEdges = new DataSet(edges);

    const options: Options = {
      autoResize: true,
      nodes: {
        shape: 'circularImage',
        font: {
          color: '#e2e8f0',
          face: 'Inter, sans-serif',
          size: 13,
          strokeWidth: 3,
          strokeColor: 'rgba(10,14,22,0.9)',
          vadjust: 4,
        },
        shadow: { enabled: false },
      },
      edges: {
        smooth: { enabled: true, type: 'continuous', roundness: 0.45 },
        selectionWidth: 2,
      },
      interaction: {
        hover: true,
        hoverConnectedEdges: false,
        zoomView: true,
        dragView: true,
        selectable: true,
        multiselect: false,
        tooltipDelay: 120,
      },
      physics: {
        enabled: false,
        stabilization: { enabled: true, iterations: 400, fit: true },
        barnesHut: {
          gravitationalConstant: -16000,
          springLength: 130,
          springConstant: 0.03,
          avoidOverlap: 0.9,
        },
      },
    };

    const network = new Network(container, { nodes: nodesDataSet, edges: edgesDataSet }, options);
    networkRef.current = network;
    setPhysicsOn(false);

    network.fit({ animation: false });

    const originalColor = (id: string) => baseColor.current.get(id) ?? '#6366f1';
    const originalSize = (id: string) => baseSize.current.get(id) ?? 12;

    const highlight = (nodeId: string) => {
      const rawConnected = network.getConnectedNodes(nodeId);
      const connected = new Set<string>(
        (Array.isArray(rawConnected) ? rawConnected : []).map(String),
      );

      const updates: Node[] = data.nodes.map((node) => {
        if (node.id === nodeId) {
          return {
            id: node.id as IdType,
            image: sphereIcon(originalColor(node.id), NODE_SELECTED_RING),
            size: originalSize(node.id) * 1.18,
          };
        }
        if (connected.has(node.id)) {
          return {
            id: node.id as IdType,
            image: sphereIcon(originalColor(node.id), NODE_NEIGHBOR_RING),
            size: originalSize(node.id),
          };
        }
        return {
          id: node.id as IdType,
          image: sphereIcon(mute(originalColor(node.id))),
          size: originalSize(node.id) * 0.9,
        };
      });
      nodesDataSet.update(updates);
      network.selectNodes([nodeId], false);
    };

    const clearHighlight = () => {
      const updates: Node[] = data.nodes.map((node) => ({
        id: node.id as IdType,
        image: sphereIcon(originalColor(node.id)),
        size: originalSize(node.id),
      }));
      nodesDataSet.update(updates);
      network.unselectAll();
    };

    network.on('click', (params?: { nodes?: IdType[] }) => {
      const [id] = params?.nodes ?? [];
      if (id === undefined || id === null) {
        clearHighlight();
        return;
      }
      const nodeId = String(id);
      const info = data.nodes.find((n) => n.id === nodeId);
      if (!info) return;

      highlight(nodeId);

      if (onNodeClickRef.current) {
        onNodeClickRef.current(info);
        return;
      }
      if (info.type === 'image') {
        navigate(`/image/${encodeURIComponent(nodeId)}`);
      } else if (info.type === 'tag') {
        navigate(`/tag/${encodeURIComponent(info.label)}`);
      }
    });

    network.on('deselectNode', () => clearHighlight());

    return () => {
      network.destroy();
      networkRef.current = null;
    };
  }, [data, navigate]);

  function togglePhysics() {
    const network = networkRef.current;
    if (!network) return;
    if (physicsOn) {
      network.stopSimulation();
      network.setOptions({ physics: { enabled: false } });
      setPhysicsOn(false);
    } else {
      network.setOptions({ physics: { enabled: true } });
      network.startSimulation();
      setPhysicsOn(true);
      network.once('stabilized', () => {
        network.stopSimulation();
        network.setOptions({ physics: { enabled: false } });
        setPhysicsOn(false);
      });
    }
  }

  function fitView() {
    networkRef.current?.fit({ animation: { duration: 300, easingFunction: 'easeInOutQuad' } });
  }

  return (
    <div className="relative h-full w-full" style={{ height }}>
      <div ref={containerRef} className="h-full w-full" />
      <div className="absolute bottom-3 right-3 z-10 flex gap-2">
        <button
          type="button"
          onClick={fitView}
          title="Centrar el grafo"
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-canvas-raised/90 px-2.5 py-1.5 text-xs font-medium text-ink-dim backdrop-blur transition-colors hover:text-ink"
        >
          <Maximize2 className="h-3.5 w-3.5" />
          Centrar
        </button>
        <button
          type="button"
          onClick={togglePhysics}
          title={physicsOn ? 'Detener la simulación' : 'Simular fuerzas (mueve los nodos)'}
          className={`inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1.5 text-xs font-medium backdrop-blur transition-colors ${
            physicsOn ? 'bg-amber-400/15 text-amber-300' : 'bg-canvas-raised/90 text-ink-dim hover:text-ink'
          }`}
        >
          {physicsOn ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
          {physicsOn ? 'Detener' : 'Simular'}
        </button>
      </div>
    </div>
  );
}
