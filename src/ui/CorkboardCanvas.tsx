import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import {
  Atom,
  Clapperboard,
  ExternalLink,
  GitBranch,
  GripVertical,
  ImagePlus,
  LayoutGrid,
  Lightbulb,
  Link2,
  List,
  MapPin,
  Minus,
  Palette,
  Plus,
  RotateCcw,
  Search,
  Tag,
  Trash2,
  User,
  X,
} from 'lucide-react';
import {
  BrainstormCard,
  BrainstormCardType,
  BrainstormLink,
  Corkboard,
  PromotedRef,
} from '../storage/schemas';
import { useTranslation } from '../i18n/useTranslation';

interface CorkboardCanvasProps {
  corkboard: Corkboard;
  onUpdateCorkboard: (next: Corkboard) => void;
  onPromoteCard: (card: BrainstormCard, target: PromotedRef['kind']) => Promise<void> | void;
  onJumpToPromotedRef: (ref: PromotedRef) => void;
}

const CARD_SWATCHES: Array<{ label: string; hex?: string }> = [
  { label: 'Default', hex: undefined },
  { label: 'Amber', hex: '#d97706' },
  { label: 'Emerald', hex: '#059669' },
  { label: 'Sky', hex: '#0284c7' },
  { label: 'Rose', hex: '#e11d48' },
  { label: 'Violet', hex: '#7c3aed' },
];

const DEFAULT_CARD_WIDTH = 248;
const DEFAULT_CARD_HEIGHT = 210;

interface CardGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

function getEdgeAnchor(from: CardGeometry, to: CardGeometry): { sx: number; sy: number; ex: number; ey: number; horizontal: boolean } {
  const fcx = from.x + from.w / 2;
  const fcy = from.y + from.h / 2;
  const tcx = to.x + to.w / 2;
  const tcy = to.y + to.h / 2;
  const dx = tcx - fcx;
  const dy = tcy - fcy;

  if (Math.abs(dx) >= Math.abs(dy)) {
    // Horizontal connection
    const goingRight = dx >= 0;
    return {
      sx: goingRight ? from.x + from.w : from.x,
      sy: fcy,
      ex: goingRight ? to.x : to.x + to.w,
      ey: tcy,
      horizontal: true,
    };
  }
  // Vertical connection
  const goingDown = dy >= 0;
  return {
    sx: fcx,
    sy: goingDown ? from.y + from.h : from.y,
    ex: tcx,
    ey: goingDown ? to.y : to.y + to.h,
    horizontal: false,
  };
}

function computeBezier(sx: number, sy: number, ex: number, ey: number, horizontal: boolean) {
  const dist = horizontal ? Math.abs(ex - sx) : Math.abs(ey - sy);
  const offset = Math.max(48, Math.min(180, dist * 0.5));
  let c1x = sx;
  let c1y = sy;
  let c2x = ex;
  let c2y = ey;

  if (horizontal) {
    const dir = ex >= sx ? 1 : -1;
    c1x = sx + dir * offset;
    c2x = ex - dir * offset;
  } else {
    const dir = ey >= sy ? 1 : -1;
    c1y = sy + dir * offset;
    c2y = ey - dir * offset;
  }

  // Cubic Bezier midpoint at t = 0.5
  const mx = 0.125 * sx + 0.375 * c1x + 0.375 * c2x + 0.125 * ex;
  const my = 0.125 * sy + 0.375 * c1y + 0.375 * c2y + 0.125 * ey;
  const d = `M ${sx} ${sy} C ${c1x} ${c1y}, ${c2x} ${c2y}, ${ex} ${ey}`;
  return { d, mx, my };
}

export default function CorkboardCanvas({
  corkboard,
  onUpdateCorkboard,
  onPromoteCard,
  onJumpToPromotedRef,
}: CorkboardCanvasProps) {
  const { t } = useTranslation();

  // Keep latest corkboard ref for clean async/pointer callbacks
  const corkboardRef = useRef(corkboard);
  useEffect(() => {
    corkboardRef.current = corkboard;
  }, [corkboard]);

  const containerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState(corkboard.viewport);
  const viewportRef = useRef(corkboard.viewport);
  useEffect(() => {
    setViewport(corkboard.viewport);
    viewportRef.current = corkboard.viewport;
  }, [corkboard.viewport]);

  // View mode (canvas vs responsive list)
  const [viewMode, setViewMode] = useState<'canvas' | 'list'>(() => {
    if (typeof window !== 'undefined' && window.innerWidth < 640) return 'list';
    return 'canvas';
  });

  // Filters
  const [typeFilter, setTypeFilter] = useState<BrainstormCardType | 'all'>('all');
  const [tagFilter, setTagFilter] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Interaction state
  const [isSpacePressed, setIsSpacePressed] = useState(false);
  const isSpaceRef = useRef(false);
  const [connectingFromId, setConnectingFromId] = useState<string | null>(null);
  const [cursorWorld, setCursorWorld] = useState<{ x: number; y: number } | null>(null);
  const [editingLinkId, setEditingLinkId] = useState<string | null>(null);
  const [openColorCardId, setOpenColorCardId] = useState<string | null>(null);
  const [openPromoteCardId, setOpenPromoteCardId] = useState<string | null>(null);
  const [tagInputByCard, setTagInputByCard] = useState<Record<string, string>>({});
  const [promotingCardId, setPromotingCardId] = useState<string | null>(null);

  // Live card heights & local drag positions for crisp 60fps dragging
  const [cardHeights, setCardHeights] = useState<Record<string, number>>({});
  const [draggingCardPos, setDraggingCardPos] = useState<{ id: string; x: number; y: number } | null>(null);

  const wheelCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cardTypeMeta: Record<
    BrainstormCardType,
    { label: string; icon: React.ComponentType<{ size?: number; className?: string }>; defaultColor: string }
  > = useMemo(
    () => ({
      idea: { label: t('corkboardTypeIdea'), icon: Lightbulb, defaultColor: '#d97706' },
      scene: { label: t('corkboardTypeScene'), icon: Clapperboard, defaultColor: '#0284c7' },
      character: { label: t('corkboardTypeCharacter'), icon: User, defaultColor: '#059669' },
      location: { label: t('corkboardTypeLocation'), icon: MapPin, defaultColor: '#7c3aed' },
      'world-rule': { label: t('corkboardTypeWorldRule'), icon: Atom, defaultColor: '#e11d48' },
      'plot-thread': { label: t('corkboardTypePlotThread'), icon: GitBranch, defaultColor: '#0f766e' },
    }),
    [t]
  );

  // Keyboard listener for Space pan & Escape cancel connect/popovers
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isEditable =
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      if (e.code === 'Space' && !isEditable) {
        e.preventDefault();
        isSpaceRef.current = true;
        setIsSpacePressed(true);
      } else if (e.key === 'Escape') {
        setConnectingFromId(null);
        setCursorWorld(null);
        setOpenColorCardId(null);
        setOpenPromoteCardId(null);
        setEditingLinkId(null);
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        isSpaceRef.current = false;
        setIsSpacePressed(false);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const allTags = useMemo(() => {
    const set = new Set<string>();
    for (const c of corkboard.cards) {
      for (const tg of c.tags) {
        if (tg.trim()) set.add(tg.trim());
      }
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [corkboard.cards]);

  const filteredCards = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return corkboard.cards.filter((c) => {
      if (typeFilter !== 'all' && c.type !== typeFilter) return false;
      if (tagFilter !== 'all' && !c.tags.includes(tagFilter)) return false;
      if (q) {
        const hay = `${c.title}\n${c.body}\n${c.tags.join(' ')}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [corkboard.cards, typeFilter, tagFilter, searchQuery]);

  const visibleCardIds = useMemo(() => new Set(filteredCards.map((c) => c.id)), [filteredCards]);

  const commitViewport = useCallback(
    (nextVp: Corkboard['viewport']) => {
      const clampedZoom = Math.min(2.5, Math.max(0.25, Number(nextVp.zoom.toFixed(3))));
      const normalized = { ...nextVp, zoom: clampedZoom };
      viewportRef.current = normalized;
      setViewport(normalized);
      onUpdateCorkboard({
        ...corkboardRef.current,
        viewport: normalized,
      });
    },
    [onUpdateCorkboard]
  );

  // Measure card element height when mounted/resized
  const registerCardRef = useCallback((cardId: string) => {
    return (el: HTMLDivElement | null) => {
      if (!el) return;
      const h = el.offsetHeight;
      if (h > 0) {
        setCardHeights((prev) => (prev[cardId] === h ? prev : { ...prev, [cardId]: h }));
      }
    };
  }, []);

  // Client coordinates -> world coordinates
  const clientToWorld = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const vp = viewportRef.current;
    if (!rect) return { x: 0, y: 0 };
    return {
      x: (clientX - rect.left - vp.panX) / vp.zoom,
      y: (clientY - rect.top - vp.panY) / vp.zoom,
    };
  }, []);

  // Pan handler (background drag, middle-click anywhere, or Space+drag anywhere)
  const handleCanvasPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const isMiddleClick = e.button === 1;
    const isBackgroundTarget = e.target === e.currentTarget || (e.target as HTMLElement).dataset.corkboardBg === 'true';

    if (!isMiddleClick && !isSpaceRef.current && !isBackgroundTarget) {
      return;
    }

    if (e.button === 0 && isBackgroundTarget && !isSpaceRef.current) {
      setOpenColorCardId(null);
      setOpenPromoteCardId(null);
      setEditingLinkId(null);
      if (connectingFromId) {
        setConnectingFromId(null);
        setCursorWorld(null);
        return;
      }
    }

    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startPanX = viewportRef.current.panX;
    const startPanY = viewportRef.current.panY;

    const onMove = (moveEvent: PointerEvent) => {
      const dx = moveEvent.clientX - startX;
      const dy = moveEvent.clientY - startY;
      const nextVp = {
        ...viewportRef.current,
        panX: startPanX + dx,
        panY: startPanY + dy,
      };
      viewportRef.current = nextVp;
      setViewport(nextVp);
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      commitViewport(viewportRef.current);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Track cursor while in Connect mode for live rubber-band wire
  const handleCanvasPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!connectingFromId) return;
    setCursorWorld(clientToWorld(e.clientX, e.clientY));
  };

  // Wheel zoom around pointer
  const handleWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (viewMode !== 'canvas') return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const vp = viewportRef.current;
    const factor = e.deltaY < 0 ? 1.09 : 0.92;
    const nextZoom = Math.min(2.5, Math.max(0.25, vp.zoom * factor));
    const pointerX = e.clientX - rect.left;
    const pointerY = e.clientY - rect.top;

    const worldX = (pointerX - vp.panX) / vp.zoom;
    const worldY = (pointerY - vp.panY) / vp.zoom;

    const nextVp: Corkboard['viewport'] = {
      zoom: Number(nextZoom.toFixed(3)),
      panX: pointerX - worldX * nextZoom,
      panY: pointerY - worldY * nextZoom,
    };

    viewportRef.current = nextVp;
    setViewport(nextVp);

    if (wheelCommitTimerRef.current) clearTimeout(wheelCommitTimerRef.current);
    wheelCommitTimerRef.current = setTimeout(() => {
      commitViewport(viewportRef.current);
    }, 220);
  };

  const adjustZoomByButton = (newZoomRaw: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const vp = viewportRef.current;
    const nextZoom = Math.min(2.5, Math.max(0.25, Number(newZoomRaw.toFixed(2))));

    if (!rect) {
      commitViewport({ ...vp, zoom: nextZoom });
      return;
    }

    const centerX = rect.width / 2;
    const centerY = rect.height / 2;
    const worldX = (centerX - vp.panX) / vp.zoom;
    const worldY = (centerY - vp.panY) / vp.zoom;

    commitViewport({
      zoom: nextZoom,
      panX: centerX - worldX * nextZoom,
      panY: centerY - worldY * nextZoom,
    });
  };

  const handleResetView = () => {
    commitViewport({ panX: 0, panY: 0, zoom: 1 });
  };

  // Card CRUD helpers
  const handleCreateCard = (type: BrainstormCardType) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const vp = viewportRef.current;
    const stagger = (corkboard.cards.length % 7) * 26;

    const centerWorldX = rect ? (rect.width / 2 - vp.panX) / vp.zoom - DEFAULT_CARD_WIDTH / 2 : 120;
    const centerWorldY = rect ? (rect.height / 2 - vp.panY) / vp.zoom - 90 : 100;

    const now = new Date().toISOString();
    const newCard: BrainstormCard = {
      id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      type,
      title: '',
      body: '',
      tags: [],
      color: cardTypeMeta[type].defaultColor,
      x: Math.round(centerWorldX + stagger - 40),
      y: Math.round(centerWorldY + stagger - 40),
      width: DEFAULT_CARD_WIDTH,
      createdAt: now,
      updatedAt: now,
    };

    onUpdateCorkboard({
      ...corkboard,
      cards: [...corkboard.cards, newCard],
    });
  };

  const updateCard = (cardId: string, patch: Partial<BrainstormCard>) => {
    const now = new Date().toISOString();
    onUpdateCorkboard({
      ...corkboardRef.current,
      cards: corkboardRef.current.cards.map((c) =>
        c.id === cardId ? { ...c, ...patch, updatedAt: now } : c
      ),
    });
  };

  const deleteCard = (cardId: string) => {
    onUpdateCorkboard({
      ...corkboardRef.current,
      cards: corkboardRef.current.cards.filter((c) => c.id !== cardId),
      links: corkboardRef.current.links.filter(
        (l) => l.fromCardId !== cardId && l.toCardId !== cardId
      ),
    });
  };

  // Card Dragging
  const handleCardDragStart = (e: React.PointerEvent<HTMLDivElement>, card: BrainstormCard) => {
    if (e.button !== 0 || isSpaceRef.current) return;
    if (connectingFromId) return;
    e.stopPropagation();
    e.preventDefault();

    const startClientX = e.clientX;
    const startClientY = e.clientY;
    const origX = card.x;
    const origY = card.y;
    let latestX = origX;
    let latestY = origY;

    const onMove = (moveEvent: PointerEvent) => {
      const z = viewportRef.current.zoom || 1;
      latestX = Math.round(origX + (moveEvent.clientX - startClientX) / z);
      latestY = Math.round(origY + (moveEvent.clientY - startClientY) / z);
      setDraggingCardPos({ id: card.id, x: latestX, y: latestY });
    };

    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      setDraggingCardPos(null);
      if (latestX !== origX || latestY !== origY) {
        updateCard(card.id, { x: latestX, y: latestY });
      }
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // Card Image Upload (compressed WebP <= 800px)
  const handleCardImageUpload = (cardId: string, e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      const img = new window.Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;
        const maxEdge = 800;

        if (width > maxEdge || height > maxEdge) {
          if (width > height) {
            height = Math.round((height * maxEdge) / width);
            width = maxEdge;
          } else {
            width = Math.round((width * maxEdge) / height);
            height = maxEdge;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(img, 0, 0, width, height);
          const base64 = canvas.toDataURL('image/webp', 0.82);
          updateCard(cardId, { image: base64 });
        }
      };
      img.src = event.target?.result as string;
    };
    reader.readAsDataURL(file);
  };

  // Connect completion & link editing
  const handleCardClickForConnect = (targetCard: BrainstormCard) => {
    if (!connectingFromId) return;
    if (connectingFromId === targetCard.id) {
      setConnectingFromId(null);
      setCursorWorld(null);
      return;
    }

    const exists = corkboard.links.some(
      (l) => l.fromCardId === connectingFromId && l.toCardId === targetCard.id
    );
    if (!exists) {
      const newLink: BrainstormLink = {
        id: `link-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        fromCardId: connectingFromId,
        toCardId: targetCard.id,
        label: '',
      };
      onUpdateCorkboard({
        ...corkboard,
        links: [...corkboard.links, newLink],
      });
      setEditingLinkId(newLink.id);
    }

    setConnectingFromId(null);
    setCursorWorld(null);
  };

  const updateLinkLabel = (linkId: string, label: string) => {
    onUpdateCorkboard({
      ...corkboardRef.current,
      links: corkboardRef.current.links.map((l) => (l.id === linkId ? { ...l, label } : l)),
    });
  };

  const deleteLink = (linkId: string) => {
    onUpdateCorkboard({
      ...corkboardRef.current,
      links: corkboardRef.current.links.filter((l) => l.id !== linkId),
    });
    if (editingLinkId === linkId) setEditingLinkId(null);
  };

  // Helper to resolve live card coordinates (including active drag offset)
  const getCardGeom = useCallback(
    (card: BrainstormCard): CardGeometry => {
      const pos = draggingCardPos?.id === card.id ? draggingCardPos : card;
      return {
        x: pos.x,
        y: pos.y,
        w: card.width || DEFAULT_CARD_WIDTH,
        h: cardHeights[card.id] || DEFAULT_CARD_HEIGHT,
      };
    },
    [draggingCardPos, cardHeights]
  );

  const visibleLinks = useMemo(() => {
    const cardMap = new Map(corkboard.cards.map((c) => [c.id, c]));
    return corkboard.links
      .map((link) => {
        const fromCard = cardMap.get(link.fromCardId);
        const toCard = cardMap.get(link.toCardId);
        if (!fromCard || !toCard) return null;
        if (!visibleCardIds.has(fromCard.id) || !visibleCardIds.has(toCard.id)) return null;
        const gFrom = getCardGeom(fromCard);
        const gTo = getCardGeom(toCard);
        const anchor = getEdgeAnchor(gFrom, gTo);
        const bezier = computeBezier(anchor.sx, anchor.sy, anchor.ex, anchor.ey, anchor.horizontal);
        return { link, ...bezier };
      })
      .filter((item): item is NonNullable<typeof item> => item !== null);
  }, [corkboard.cards, corkboard.links, visibleCardIds, getCardGeom]);

  const rubberBand = useMemo(() => {
    if (!connectingFromId || !cursorWorld) return null;
    const fromCard = corkboard.cards.find((c) => c.id === connectingFromId);
    if (!fromCard) return null;
    const gFrom = getCardGeom(fromCard);
    const cursorGeom: CardGeometry = { x: cursorWorld.x, y: cursorWorld.y, w: 1, h: 1 };
    const anchor = getEdgeAnchor(gFrom, cursorGeom);
    return computeBezier(anchor.sx, anchor.sy, anchor.ex, anchor.ey, anchor.horizontal);
  }, [connectingFromId, cursorWorld, corkboard.cards, getCardGeom]);

  const handleAddTag = (card: BrainstormCard) => {
    const raw = (tagInputByCard[card.id] || '').trim().replace(/^#/, '');
    if (!raw) return;
    if (!card.tags.some((existing) => existing.toLowerCase() === raw.toLowerCase())) {
      updateCard(card.id, { tags: [...card.tags, raw] });
    }
    setTagInputByCard((prev) => ({ ...prev, [card.id]: '' }));
  };

  const handlePromote = async (card: BrainstormCard, target: PromotedRef['kind']) => {
    setOpenPromoteCardId(null);
    setPromotingCardId(card.id);
    try {
      await onPromoteCard(card, target);
    } finally {
      setPromotingCardId(null);
    }
  };

  const cardTypeList: BrainstormCardType[] = ['idea', 'scene', 'character', 'location', 'world-rule', 'plot-thread'];

  return (
    <div className="h-full w-full flex flex-col bg-[var(--editor-bg)] text-[var(--foreground)] overflow-hidden select-none">
      {/* Top Corkboard Toolbar */}
      <div className="px-3 sm:px-5 py-2.5 border-b border-[var(--border)] bg-[var(--sidebar-bg)] flex flex-wrap items-center justify-between gap-2.5 z-20">
        {/* Card Creation Buttons */}
        <div className="flex flex-wrap items-center gap-1.5">
          {cardTypeList.map((typeKey) => {
            const meta = cardTypeMeta[typeKey];
            const Icon = meta.icon;
            return (
              <button
                key={typeKey}
                onClick={() => handleCreateCard(typeKey)}
                className="inline-flex items-center gap-1 px-2.5 py-1 border border-[var(--border)] bg-white dark:bg-[#1e1e1d] hover:border-[var(--accent)] text-[11px] font-semibold transition-colors cursor-pointer"
                title={`${t('corkboardAddPrefix')}${meta.label}`}
              >
                <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ backgroundColor: meta.defaultColor }} />
                <Icon size={12} className="opacity-75" />
                <span>{t('corkboardAddPrefix')}{meta.label}</span>
              </button>
            );
          })}
        </div>

        {/* Filters + Zoom + View Switcher */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Search */}
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 opacity-50 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('corkboardSearchPlaceholder')}
              className="pl-6 pr-6 py-1 w-36 sm:w-44 border border-[var(--border)] bg-white dark:bg-[#1e1e1d] text-[11px] focus:outline-none focus:border-[var(--accent)]"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 opacity-60 hover:opacity-100 cursor-pointer"
                aria-label="Clear search"
              >
                <X size={11} />
              </button>
            )}
          </div>

          {/* Type Filter */}
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value as BrainstormCardType | 'all')}
            className="px-2 py-1 border border-[var(--border)] bg-white dark:bg-[#1e1e1d] text-[11px] font-medium focus:outline-none focus:border-[var(--accent)] cursor-pointer"
          >
            <option value="all">{t('corkboardTypeAll')}</option>
            {cardTypeList.map((typeKey) => (
              <option key={typeKey} value={typeKey}>
                {cardTypeMeta[typeKey].label}
              </option>
            ))}
          </select>

          {/* Tag Filter */}
          {allTags.length > 0 && (
            <select
              value={tagFilter}
              onChange={(e) => setTagFilter(e.target.value)}
              className="px-2 py-1 border border-[var(--border)] bg-white dark:bg-[#1e1e1d] text-[11px] font-medium focus:outline-none focus:border-[var(--accent)] cursor-pointer"
            >
              <option value="all">{t('corkboardAllTags')}</option>
              {allTags.map((tg) => (
                <option key={tg} value={tg}>
                  #{tg}
                </option>
              ))}
            </select>
          )}

          {/* Zoom Controls (Canvas mode) */}
          {viewMode === 'canvas' && (
            <div className="inline-flex items-center border border-[var(--border)] bg-white dark:bg-[#1e1e1d]">
              <button
                onClick={() => adjustZoomByButton(viewport.zoom - 0.15)}
                className="p-1 hover:bg-[var(--border)]/50 cursor-pointer"
                title="Zoom Out"
              >
                <Minus size={12} />
              </button>
              <button
                onClick={() => adjustZoomByButton(1)}
                className="px-2 py-0.5 text-[11px] font-mono border-x border-[var(--border)] hover:bg-[var(--border)]/40 cursor-pointer"
                title="100%"
              >
                {Math.round(viewport.zoom * 100)}%
              </button>
              <button
                onClick={() => adjustZoomByButton(viewport.zoom + 0.15)}
                className="p-1 hover:bg-[var(--border)]/50 cursor-pointer"
                title="Zoom In"
              >
                <Plus size={12} />
              </button>
              <button
                onClick={handleResetView}
                className="p-1 border-l border-[var(--border)] hover:bg-[var(--border)]/50 cursor-pointer"
                title={t('corkboardResetView')}
              >
                <RotateCcw size={12} />
              </button>
            </div>
          )}

          {/* Canvas / List Mode Toggle */}
          <div className="inline-flex border border-[var(--border)] bg-[var(--border)] p-0.5 text-[11px]">
            <button
              onClick={() => setViewMode('canvas')}
              className={`inline-flex items-center gap-1 px-2 py-0.5 font-semibold cursor-pointer ${
                viewMode === 'canvas' ? 'bg-white dark:bg-[#20201e] text-[var(--accent)] shadow-sm' : 'opacity-70 hover:opacity-100'
              }`}
            >
              <LayoutGrid size={12} />
              <span>{t('corkboardCanvasView')}</span>
            </button>
            <button
              onClick={() => setViewMode('list')}
              className={`inline-flex items-center gap-1 px-2 py-0.5 font-semibold cursor-pointer ${
                viewMode === 'list' ? 'bg-white dark:bg-[#20201e] text-[var(--accent)] shadow-sm' : 'opacity-70 hover:opacity-100'
              }`}
            >
              <List size={12} />
              <span>{t('corkboardListView')}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Connect Mode Banner */}
      {connectingFromId && (
        <div className="px-4 py-1.5 bg-[var(--accent)]/15 border-b border-[var(--accent)]/30 text-xs flex items-center justify-between gap-3 z-20">
          <span className="font-semibold text-[var(--accent)] flex items-center gap-1.5">
            <Link2 size={13} />
            <span>{t('corkboardConnectHint')}</span>
          </span>
          <button
            onClick={() => {
              setConnectingFromId(null);
              setCursorWorld(null);
            }}
            className="px-2 py-0.5 border border-[var(--accent)]/40 text-[11px] font-bold hover:bg-[var(--accent)] hover:text-white cursor-pointer"
          >
            {t('corkboardCancelConnect')}
          </button>
        </div>
      )}

      {/* Main Surface */}
      {viewMode === 'list' ? (
        /* Responsive Board List View (mobile & accessibility fallback) */
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          {filteredCards.length === 0 ? (
            <div className="h-full min-h-[260px] flex flex-col items-center justify-center text-center max-w-md mx-auto opacity-70 space-y-2">
              <LayoutGrid size={28} className="opacity-40" />
              <p className="text-sm font-bold">{t('corkboardEmptyTitle')}</p>
              <p className="text-xs opacity-75">{t('corkboardEmptyDesc')}</p>
            </div>
          ) : (
            <div className="max-w-5xl mx-auto grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pb-16">
              {filteredCards.map((card) => {
                const meta = cardTypeMeta[card.type];
                const TypeIcon = meta.icon;
                const outgoingLinks = corkboard.links.filter((l) => l.fromCardId === card.id);
                return (
                  <div
                    key={card.id}
                    className="bg-white dark:bg-[#1e1e1d] border border-[var(--border)] flex flex-col overflow-hidden shadow-sm"
                    style={{ borderTopWidth: '3px', borderTopColor: card.color || meta.defaultColor }}
                  >
                    <div className="px-3 py-2 border-b border-[var(--border)]/40 flex items-center justify-between gap-2 bg-[var(--sidebar-bg)]/50">
                      <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-wider opacity-80">
                        <TypeIcon size={12} />
                        <span>{meta.label}</span>
                      </span>
                      <button
                        onClick={() => deleteCard(card.id)}
                        className="p-1 opacity-55 hover:opacity-100 hover:text-red-500 cursor-pointer"
                        title={t('delete')}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>

                    {card.image && (
                      <div className="relative">
                        <Image
                          src={card.image}
                          alt={card.title || 'Card image'}
                          width={320}
                          height={160}
                          referrerPolicy="no-referrer"
                          className="w-full h-32 object-cover border-b border-[var(--border)]"
                        />
                        <button
                          onClick={() => updateCard(card.id, { image: undefined })}
                          className="absolute top-1.5 right-1.5 p-1 bg-black/60 text-white hover:bg-black/80 cursor-pointer"
                          title={t('corkboardRemoveImage')}
                        >
                          <X size={11} />
                        </button>
                      </div>
                    )}

                    <div className="p-3 space-y-2 flex-1 flex flex-col">
                      <input
                        type="text"
                        value={card.title}
                        onChange={(e) => updateCard(card.id, { title: e.target.value })}
                        placeholder={t('corkboardCardTitlePlaceholder')}
                        className="w-full text-xs font-bold bg-transparent border-b border-transparent focus:border-[var(--accent)] focus:outline-none pb-0.5 select-text"
                      />
                      <textarea
                        value={card.body}
                        onChange={(e) => updateCard(card.id, { body: e.target.value })}
                        placeholder={t('corkboardCardBodyPlaceholder')}
                        rows={3}
                        className="w-full text-xs bg-transparent resize-y focus:outline-none opacity-85 select-text"
                      />

                      {card.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-1">
                          {card.tags.map((tg) => (
                            <span
                              key={tg}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-[var(--border)] text-[10px] font-mono bg-[var(--editor-bg)]"
                            >
                              #{tg}
                              <button
                                onClick={() => updateCard(card.id, { tags: card.tags.filter((x) => x !== tg) })}
                                className="opacity-60 hover:opacity-100 cursor-pointer"
                              >
                                <X size={9} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}

                      {outgoingLinks.length > 0 && (
                        <div className="pt-1 space-y-1 text-[10px] opacity-75">
                          {outgoingLinks.map((lk) => {
                            const target = corkboard.cards.find((c) => c.id === lk.toCardId);
                            return (
                              <div key={lk.id} className="flex items-center justify-between gap-1 px-1.5 py-0.5 bg-[var(--editor-bg)] border border-[var(--border)]/40">
                                <span className="truncate">
                                  → {lk.label ? `[${lk.label}] ` : ''}
                                  {target?.title || t('corkboardCardTitlePlaceholder')}
                                </span>
                                <button onClick={() => deleteLink(lk.id)} className="opacity-60 hover:text-red-500 cursor-pointer">
                                  <X size={10} />
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      )}

                      <div className="pt-2 mt-auto border-t border-[var(--border)]/30 flex flex-wrap items-center justify-between gap-2">
                        {card.promotedRef ? (
                          <button
                            onClick={() => onJumpToPromotedRef(card.promotedRef!)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 bg-[var(--accent)]/10 border border-[var(--accent)]/35 text-[var(--accent)] text-[10px] font-bold hover:bg-[var(--accent)] hover:text-white transition-colors cursor-pointer"
                          >
                            <ExternalLink size={10} />
                            <span className="truncate max-w-[160px]">
                              {t('corkboardJumpTo')}: {card.promotedRef.label || card.title}
                            </span>
                          </button>
                        ) : (
                          <span />
                        )}

                        <div className="relative">
                          <button
                            disabled={promotingCardId === card.id}
                            onClick={() =>
                              setOpenPromoteCardId((prev) => (prev === card.id ? null : card.id))
                            }
                            className="inline-flex items-center gap-1 px-2 py-0.5 border border-[var(--border)] hover:border-[var(--accent)] text-[10px] font-semibold cursor-pointer"
                          >
                            <ExternalLink size={10} />
                            <span>{t('corkboardPromote')}</span>
                          </button>
                          {openPromoteCardId === card.id && (
                            <div className="absolute right-0 bottom-full mb-1 w-48 bg-white dark:bg-[#1e1e1d] border border-[var(--border)] shadow-xl z-40 py-1 text-xs">
                              {(
                                [
                                  ['chapter', t('corkboardPromoteChapter')],
                                  ['character', t('corkboardPromoteCharacter')],
                                  ['location', t('corkboardPromoteLocation')],
                                  ['item', t('corkboardPromoteItem')],
                                  ['world-rule', t('corkboardPromoteWorldRule')],
                                ] as Array<[PromotedRef['kind'], string]>
                              ).map(([kind, label]) => (
                                <button
                                  key={kind}
                                  onClick={() => void handlePromote(card, kind)}
                                  className="w-full text-left px-3 py-1.5 hover:bg-[var(--border)]/40 text-[11px] font-medium cursor-pointer"
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ) : (
        /* Spatial 2D Pan/Zoom Canvas */
        <div
          ref={containerRef}
          data-corkboard-bg="true"
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handleCanvasPointerMove}
          onWheel={handleWheel}
          className={`flex-1 relative overflow-hidden ${
            isSpacePressed ? 'cursor-grab active:cursor-grabbing' : connectingFromId ? 'cursor-crosshair' : 'cursor-default'
          }`}
          style={{
            backgroundImage: 'radial-gradient(circle, rgba(128,128,128,0.22) 1px, transparent 1px)',
            backgroundSize: `${Math.max(12, 24 * viewport.zoom)}px ${Math.max(12, 24 * viewport.zoom)}px`,
            backgroundPosition: `${viewport.panX}px ${viewport.panY}px`,
          }}
        >
          {/* Empty Board Guidance Overlay */}
          {corkboard.cards.length === 0 && (
            <div
              data-corkboard-bg="true"
              className="absolute inset-0 flex flex-col items-center justify-center text-center p-6 pointer-events-none"
            >
              <div className="max-w-md space-y-2 opacity-65">
                <LayoutGrid size={32} className="mx-auto opacity-45" />
                <p className="text-sm font-bold">{t('corkboardEmptyTitle')}</p>
                <p className="text-xs leading-relaxed">{t('corkboardEmptyDesc')}</p>
              </div>
            </div>
          )}

          {/* World Coordinate Layer */}
          <div
            data-corkboard-bg="true"
            className="absolute top-0 left-0 origin-top-left"
            style={{
              transform: `translate(${viewport.panX}px, ${viewport.panY}px) scale(${viewport.zoom})`,
            }}
          >
            {/* SVG Directional Connectors Layer */}
            <svg className="overflow-visible pointer-events-none absolute top-0 left-0 w-px h-px" style={{ zIndex: 1 }}>
              <defs>
                <marker
                  id="corkboard-arrow"
                  viewBox="0 0 10 10"
                  refX="8"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1.5 L 8.5 5 L 0 8.5 z" fill="currentColor" className="text-[var(--accent)]" />
                </marker>
              </defs>

              {visibleLinks.map(({ link, d }) => (
                <path
                  key={link.id}
                  d={d}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  markerEnd="url(#corkboard-arrow)"
                  className="text-[var(--accent)]/65"
                />
              ))}

              {rubberBand && (
                <path
                  d={rubberBand.d}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  markerEnd="url(#corkboard-arrow)"
                  className="text-[var(--accent)]"
                />
              )}
            </svg>

            {/* Interactive Connector Midpoint Labels */}
            {visibleLinks.map(({ link, mx, my }) => {
              const isEditing = editingLinkId === link.id;
              return (
                <div
                  key={`label-${link.id}`}
                  style={{
                    left: `${mx}px`,
                    top: `${my}px`,
                    transform: 'translate(-50%, -50%)',
                    zIndex: isEditing ? 30 : 12,
                  }}
                  onPointerDown={(e) => e.stopPropagation()}
                  className="absolute"
                >
                  {isEditing ? (
                    <div className="flex items-center gap-1 bg-white dark:bg-[#1e1e1d] border border-[var(--accent)] shadow-md px-1.5 py-0.5">
                      <input
                        autoFocus
                        type="text"
                        value={link.label}
                        onChange={(e) => updateLinkLabel(link.id, e.target.value)}
                        onBlur={() => setEditingLinkId(null)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === 'Escape') {
                            setEditingLinkId(null);
                          }
                        }}
                        placeholder={t('corkboardLinkLabelPlaceholder')}
                        className="w-28 text-[10px] bg-transparent focus:outline-none select-text"
                      />
                      <button
                        onMouseDown={(e) => {
                          e.preventDefault();
                          deleteLink(link.id);
                        }}
                        className="text-red-500 hover:opacity-80 cursor-pointer"
                        title={t('corkboardDeleteLink')}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ) : (
                    <div className="group inline-flex items-center gap-1 px-2 py-0.5 bg-white/95 dark:bg-[#1e1e1d]/95 border border-[var(--border)] shadow-sm text-[10px] hover:border-[var(--accent)] transition-colors">
                      <button
                        onClick={() => setEditingLinkId(link.id)}
                        className="font-medium opacity-80 hover:opacity-100 cursor-pointer"
                      >
                        {link.label.trim() ? link.label : t('corkboardAddLinkLabel')}
                      </button>
                      <button
                        onClick={() => deleteLink(link.id)}
                        className="opacity-0 group-hover:opacity-75 hover:!opacity-100 hover:text-red-500 cursor-pointer"
                        title={t('corkboardDeleteLink')}
                      >
                        <X size={10} />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Spatial Cards */}
            {filteredCards.map((card) => {
              const meta = cardTypeMeta[card.type];
              const TypeIcon = meta.icon;
              const livePos = draggingCardPos?.id === card.id ? draggingCardPos : card;
              const isConnectingSource = connectingFromId === card.id;
              const isColorOpen = openColorCardId === card.id;
              const isPromoteOpen = openPromoteCardId === card.id;
              const accentColor = card.color || meta.defaultColor;

              return (
                <div
                  key={card.id}
                  ref={registerCardRef(card.id)}
                  onClick={() => {
                    if (connectingFromId) {
                      handleCardClickForConnect(card);
                    }
                  }}
                  onPointerDown={(e) => {
                    if (connectingFromId) {
                      e.stopPropagation();
                    }
                  }}
                  style={{
                    left: `${livePos.x}px`,
                    top: `${livePos.y}px`,
                    width: `${card.width || DEFAULT_CARD_WIDTH}px`,
                    borderTopWidth: '3px',
                    borderTopColor: accentColor,
                    zIndex: draggingCardPos?.id === card.id ? 25 : isPromoteOpen || isColorOpen ? 24 : 5,
                  }}
                  className={`absolute bg-white dark:bg-[#1e1e1d] border shadow-md flex flex-col transition-shadow ${
                    isConnectingSource
                      ? 'border-[var(--accent)] ring-2 ring-[var(--accent)]/40'
                      : connectingFromId
                      ? 'border-[var(--border)] hover:border-[var(--accent)] cursor-crosshair'
                      : 'border-[var(--border)] hover:shadow-lg'
                  }`}
                >
                  {/* Card Drag Handle Header */}
                  <div
                    onPointerDown={(e) => handleCardDragStart(e, card)}
                    className="px-2.5 py-1.5 border-b border-[var(--border)]/40 bg-[var(--sidebar-bg)]/60 flex items-center justify-between gap-1.5 cursor-grab active:cursor-grabbing"
                  >
                    <div className="flex items-center gap-1 min-w-0">
                      <GripVertical size={12} className="opacity-45 shrink-0" />
                      <TypeIcon size={11} className="opacity-75 shrink-0" />
                      <select
                        value={card.type}
                        onPointerDown={(e) => e.stopPropagation()}
                        onChange={(e) => updateCard(card.id, { type: e.target.value as BrainstormCardType })}
                        className="text-[10px] font-bold uppercase tracking-wider bg-transparent focus:outline-none cursor-pointer opacity-80 hover:opacity-100 truncate"
                      >
                        {cardTypeList.map((typeKey) => (
                          <option key={typeKey} value={typeKey}>
                            {cardTypeMeta[typeKey].label}
                          </option>
                        ))}
                      </select>
                    </div>

                    {/* Header Quick Actions */}
                    <div
                      className="flex items-center gap-0.5 shrink-0 relative"
                      onPointerDown={(e) => e.stopPropagation()}
                    >
                      {/* Color Swatch Picker */}
                      <button
                        onClick={() => {
                          setOpenColorCardId((prev) => (prev === card.id ? null : card.id));
                          setOpenPromoteCardId(null);
                        }}
                        className="p-1 opacity-60 hover:opacity-100 cursor-pointer"
                        title={t('highlightColor')}
                      >
                        <Palette size={11} />
                      </button>
                      {isColorOpen && (
                        <div className="absolute right-0 top-full mt-1 p-1.5 bg-white dark:bg-[#1e1e1d] border border-[var(--border)] shadow-xl flex items-center gap-1 z-40">
                          {CARD_SWATCHES.map((sw) => (
                            <button
                              key={sw.label}
                              onClick={() => {
                                updateCard(card.id, { color: sw.hex });
                                setOpenColorCardId(null);
                              }}
                              className="w-4 h-4 border border-[var(--border)] cursor-pointer"
                              style={{ backgroundColor: sw.hex || 'var(--sidebar-bg)' }}
                              title={sw.label}
                            />
                          ))}
                        </div>
                      )}

                      {/* Image Upload */}
                      <label
                        className="p-1 opacity-60 hover:opacity-100 cursor-pointer"
                        title={t('corkboardAttachImage')}
                      >
                        <ImagePlus size={11} />
                        <input
                          type="file"
                          accept="image/png, image/jpeg, image/webp"
                          onChange={(e) => handleCardImageUpload(card.id, e)}
                          className="hidden"
                        />
                      </label>

                      {/* Delete */}
                      <button
                        onClick={() => deleteCard(card.id)}
                        className="p-1 opacity-60 hover:opacity-100 hover:text-red-500 cursor-pointer"
                        title={t('delete')}
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  </div>

                  {/* Optional Image Banner */}
                  {card.image && (
                    <div className="relative group" onPointerDown={(e) => e.stopPropagation()}>
                      <Image
                        src={card.image}
                        alt={card.title || 'Card attachment'}
                        width={DEFAULT_CARD_WIDTH}
                        height={120}
                        referrerPolicy="no-referrer"
                        className="w-full h-28 object-cover border-b border-[var(--border)]"
                      />
                      <button
                        onClick={() => updateCard(card.id, { image: undefined })}
                        className="absolute top-1 right-1 p-1 bg-black/65 text-white opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                        title={t('corkboardRemoveImage')}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  )}

                  {/* Card Body */}
                  <div className="p-2.5 space-y-2" onPointerDown={(e) => e.stopPropagation()}>
                    <input
                      type="text"
                      value={card.title}
                      onChange={(e) => updateCard(card.id, { title: e.target.value })}
                      placeholder={t('corkboardCardTitlePlaceholder')}
                      className="w-full text-xs font-bold bg-transparent border-b border-transparent focus:border-[var(--accent)] focus:outline-none pb-0.5 select-text"
                    />
                    <textarea
                      value={card.body}
                      onChange={(e) => updateCard(card.id, { body: e.target.value })}
                      placeholder={t('corkboardCardBodyPlaceholder')}
                      rows={3}
                      className="w-full text-[11px] leading-relaxed bg-transparent resize-y focus:outline-none opacity-85 select-text"
                    />

                    {/* Tags */}
                    <div className="space-y-1.5">
                      {card.tags.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {card.tags.map((tg) => (
                            <span
                              key={tg}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 border border-[var(--border)] bg-[var(--editor-bg)] text-[10px] font-mono"
                            >
                              #{tg}
                              <button
                                onClick={() => updateCard(card.id, { tags: card.tags.filter((x) => x !== tg) })}
                                className="opacity-60 hover:opacity-100 cursor-pointer"
                              >
                                <X size={9} />
                              </button>
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="flex items-center gap-1 opacity-75 focus-within:opacity-100">
                        <Tag size={10} className="opacity-55 shrink-0" />
                        <input
                          type="text"
                          value={tagInputByCard[card.id] || ''}
                          onChange={(e) => setTagInputByCard((prev) => ({ ...prev, [card.id]: e.target.value }))}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleAddTag(card);
                            }
                          }}
                          placeholder={t('corkboardAddTagPlaceholder')}
                          className="w-full text-[10px] bg-transparent focus:outline-none select-text"
                        />
                      </div>
                    </div>

                    {/* Promoted Reference Jump Badge */}
                    {card.promotedRef && (
                      <button
                        onClick={() => onJumpToPromotedRef(card.promotedRef!)}
                        className="w-full flex items-center justify-between gap-1.5 px-2 py-1 bg-[var(--accent)]/10 border border-[var(--accent)]/35 text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white text-[10px] font-bold transition-colors cursor-pointer"
                      >
                        <span className="truncate">
                          {t('corkboardJumpTo')}: {card.promotedRef.label || card.title}
                        </span>
                        <ExternalLink size={10} className="shrink-0" />
                      </button>
                    )}

                    {/* Card Footer Actions */}
                    <div className="pt-1.5 border-t border-[var(--border)]/30 flex items-center justify-between gap-2 relative">
                      <button
                        onClick={() => {
                          if (connectingFromId === card.id) {
                            setConnectingFromId(null);
                            setCursorWorld(null);
                          } else {
                            setConnectingFromId(card.id);
                          }
                        }}
                        className={`inline-flex items-center gap-1 px-2 py-0.5 border text-[10px] font-semibold transition-colors cursor-pointer ${
                          isConnectingSource
                            ? 'border-[var(--accent)] bg-[var(--accent)] text-white'
                            : 'border-[var(--border)] hover:border-[var(--accent)]'
                        }`}
                      >
                        <Link2 size={10} />
                        <span>{t('corkboardConnect')}</span>
                      </button>

                      <div className="relative">
                        <button
                          disabled={promotingCardId === card.id}
                          onClick={() => {
                            setOpenPromoteCardId((prev) => (prev === card.id ? null : card.id));
                            setOpenColorCardId(null);
                          }}
                          className="inline-flex items-center gap-1 px-2 py-0.5 border border-[var(--border)] hover:border-[var(--accent)] text-[10px] font-semibold cursor-pointer disabled:opacity-50"
                        >
                          <ExternalLink size={10} />
                          <span>{t('corkboardPromote')}</span>
                        </button>

                        {isPromoteOpen && (
                          <div className="absolute right-0 bottom-full mb-1 w-48 bg-white dark:bg-[#1e1e1d] border border-[var(--border)] shadow-xl z-40 py-1 text-xs">
                            {(
                              [
                                ['chapter', t('corkboardPromoteChapter')],
                                ['character', t('corkboardPromoteCharacter')],
                                ['location', t('corkboardPromoteLocation')],
                                ['item', t('corkboardPromoteItem')],
                                ['world-rule', t('corkboardPromoteWorldRule')],
                              ] as Array<[PromotedRef['kind'], string]>
                            ).map(([kind, label]) => (
                              <button
                                key={kind}
                                onClick={() => void handlePromote(card, kind)}
                                className="w-full text-left px-3 py-1.5 hover:bg-[var(--border)]/40 text-[11px] font-medium cursor-pointer"
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
