import React, { useState, useEffect, useRef } from 'react';
import { 
  format, 
  addWeeks, 
  subWeeks, 
  startOfWeek, 
  endOfWeek, 
  eachDayOfInterval, 
  isToday
} from 'date-fns';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

// Types
type Interval = 15 | 30 | 60;
type CellColor = 'sage' | 'peach' | 'blue' | 'sand' | 'lilac' | 'transparent';

interface CellData {
  id: string; // ISO date + time slot (e.g. "2023-10-25T08:00")
  content: string;
  color: CellColor;
}

interface WeekData {
  [cellId: string]: CellData;
}

// Color palettes for cells
const CELL_COLORS: Record<CellColor, string> = {
  sage: 'bg-[#eef1ed] border-[#d8e0d5] text-[#4a5d43]',
  peach: 'bg-[#fcf2ed] border-[#f5e0d3] text-[#8a5a40]',
  blue: 'bg-[#f0f4f8] border-[#d9e6f2] text-[#426485]',
  sand: 'bg-[#f9f5ed] border-[#efe5d3] text-[#85704a]',
  lilac: 'bg-[#f6f2f8] border-[#e8dcf0] text-[#6d5086]',
  transparent: 'bg-transparent border-transparent text-foreground hover:bg-black/5'
};

const COLOR_PICKER_SWATCHES: Record<CellColor, string> = {
  sage: 'bg-[#eef1ed] border-[#d8e0d5]',
  peach: 'bg-[#fcf2ed] border-[#f5e0d3]',
  blue: 'bg-[#f0f4f8] border-[#d9e6f2]',
  sand: 'bg-[#f9f5ed] border-[#efe5d3]',
  lilac: 'bg-[#f6f2f8] border-[#e8dcf0]',
  transparent: 'bg-white border-[#e6e4e0]'
};

// Utils — cell IDs are keyed by day-of-week (0=Mon…6=Sun) + time, shared across all weeks
const TEMPLATE_KEY = 'planner-template';

const generateTimeSlots = (interval: Interval) => {
  const slots = [];
  // 7 AM to 10 PM (15 hours)
  const startHour = 7;
  const endHour = 22;
  
  for (let hour = startHour; hour <= endHour; hour++) {
    for (let minute = 0; minute < 60; minute += interval) {
      slots.push(`${hour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}`);
    }
  }
  return slots;
};

// Main Component
export default function WeeklyPlanner() {
  const [currentDate, setCurrentDate] = useState(new Date());
  const [intervalOption, setIntervalOption] = useState<Interval>(60);
  const [weekData, setWeekData] = useState<WeekData>({});
  const [editingCell, setEditingCell] = useState<string | null>(null);
  const [hoveredCell, setHoveredCell] = useState<string | null>(null);
  const [direction, setDirection] = useState(0); // 1 for next, -1 for prev
  
  const editInputRef = useRef<HTMLTextAreaElement>(null);

  // Derived state
  const start = startOfWeek(currentDate, { weekStartsOn: 1 });
  const end = endOfWeek(currentDate, { weekStartsOn: 1 });
  const days = eachDayOfInterval({ start, end });
  const timeSlots = generateTimeSlots(intervalOption);

  // Load shared template data on mount only
  useEffect(() => {
    const saved = localStorage.getItem(TEMPLATE_KEY);
    if (saved) {
      setWeekData(JSON.parse(saved));
    }
    
    const savedInterval = localStorage.getItem('planner-interval');
    if (savedInterval) {
      setIntervalOption(parseInt(savedInterval, 10) as Interval);
    }
  }, []);

  // Save shared template data whenever it changes
  useEffect(() => {
    if (Object.keys(weekData).length > 0) {
      localStorage.setItem(TEMPLATE_KEY, JSON.stringify(weekData));
    } else {
      localStorage.removeItem(TEMPLATE_KEY);
    }
  }, [weekData]);

  // Save interval effect
  useEffect(() => {
    localStorage.setItem('planner-interval', intervalOption.toString());
  }, [intervalOption]);

  // Focus input when editing
  useEffect(() => {
    if (editingCell && editInputRef.current) {
      editInputRef.current.focus();
      // Place cursor at the end
      const len = editInputRef.current.value.length;
      editInputRef.current.setSelectionRange(len, len);
    }
  }, [editingCell]);

  // Handlers
  const handlePrevWeek = () => {
    setDirection(-1);
    setCurrentDate(subWeeks(currentDate, 1));
    setEditingCell(null);
  };

  const handleNextWeek = () => {
    setDirection(1);
    setCurrentDate(addWeeks(currentDate, 1));
    setEditingCell(null);
  };

  const handleToday = () => {
    setDirection(0);
    setCurrentDate(new Date());
    setEditingCell(null);
  };

  const updateCell = (id: string, content: string, color?: CellColor) => {
    setWeekData(prev => {
      const existing = prev[id] || { id, content: '', color: 'sage' };
      
      // If empty content, remove the cell entirely unless we are just changing color on an existing one
      if (!content.trim() && (!existing.content.trim() || color === undefined)) {
        const newData = { ...prev };
        delete newData[id];
        return newData;
      }
      
      return {
        ...prev,
        [id]: {
          ...existing,
          content: content,
          color: color || existing.color
        }
      };
    });
  };

  const clearCell = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setWeekData(prev => {
      const newData = { ...prev };
      delete newData[id];
      return newData;
    });
    setEditingCell(null);
  };

  const handleCellClick = (id: string) => {
    if (editingCell === id) return;
    setEditingCell(id);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>, id: string) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      setEditingCell(null);
    }
    if (e.key === 'Escape') {
      setEditingCell(null);
    }
  };

  // Animation variants
  const variants = {
    enter: (direction: number) => {
      return {
        x: direction > 0 ? 30 : direction < 0 ? -30 : 0,
        opacity: 0
      };
    },
    center: {
      zIndex: 1,
      x: 0,
      opacity: 1
    },
    exit: (direction: number) => {
      return {
        zIndex: 0,
        x: direction < 0 ? 30 : direction > 0 ? -30 : 0,
        opacity: 0
      };
    }
  };

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col font-sans selection:bg-primary/20">
      {/* Header */}
      <header className="sticky top-0 z-20 bg-background/80 backdrop-blur-md border-b border-border/50">
        <div className="max-w-[1400px] mx-auto px-6 h-20 flex items-center justify-between">
          <div className="flex items-center space-x-6">
            <h1 className="text-xl font-medium tracking-tight text-foreground/90">
              {format(start, 'MMMM yyyy')}
            </h1>
            
            <div className="flex items-center bg-white/50 border border-border/80 rounded-md p-1 shadow-sm">
              <button 
                onClick={handlePrevWeek}
                className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-black/5 transition-colors"
                aria-label="Previous week"
              >
                <ChevronLeft size={16} />
              </button>
              <button 
                onClick={handleToday}
                className="px-3 py-1 text-sm font-medium text-foreground/80 hover:text-foreground hover:bg-black/5 rounded transition-colors"
              >
                Today
              </button>
              <button 
                onClick={handleNextWeek}
                className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-black/5 transition-colors"
                aria-label="Next week"
              >
                <ChevronRight size={16} />
              </button>
            </div>
          </div>

          <div className="flex items-center space-x-2">
            <span className="text-xs font-medium text-muted-foreground uppercase tracking-widest">Interval</span>
            <div className="flex bg-white/50 border border-border/80 rounded-md p-0.5 shadow-sm">
              {[15, 30, 60].map(val => (
                <button
                  key={val}
                  onClick={() => setIntervalOption(val as Interval)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-sm transition-all duration-200 ${
                    intervalOption === val 
                      ? 'bg-white shadow-[0_1px_3px_rgba(0,0,0,0.05)] text-foreground' 
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {val}m
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      {/* Grid Container */}
      <main className="flex-1 overflow-x-auto overflow-y-scroll custom-scrollbar">
        <div className="min-w-[1000px] max-w-[1400px] mx-auto p-6 pb-20">
          
          <AnimatePresence initial={false} custom={direction} mode="wait">
            <motion.div
              key={currentDate.toISOString()}
              custom={direction}
              variants={variants}
              initial="enter"
              animate="center"
              exit="exit"
              transition={{
                x: { type: "spring", stiffness: 300, damping: 30 },
                opacity: { duration: 0.2 }
              }}
              className="flex border border-border/60 rounded-xl overflow-hidden bg-white/40 shadow-sm"
            >
              {/* Time Axis */}
              <div className="w-16 flex-shrink-0 border-r border-border/60 bg-background/50">
                <div className="h-14 border-b border-border/60"></div> {/* Empty top-left cell */}
                {timeSlots.map(time => {
                  const isHour = time.endsWith(':00');
                  return (
                    <div 
                      key={`axis-${time}`} 
                      className={`relative border-b border-border/30 flex items-start justify-center pt-2 ${
                        intervalOption === 60 ? 'h-24' : intervalOption === 30 ? 'h-16' : 'h-10'
                      }`}
                    >
                      {isHour && (
                        <span className="text-[10px] font-medium text-muted-foreground tabular-nums -mt-4 bg-background/50 px-1">
                          {time}
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Days Columns */}
              <div className="flex-1 grid grid-cols-7">
                {days.map((day, colIdx) => {
                  const isCurrentDay = isToday(day);
                  
                  return (
                    <div 
                      key={`col-${colIdx}`} 
                      className={`flex flex-col border-r border-border/60 last:border-r-0 ${
                        isCurrentDay ? 'bg-primary/[0.03]' : ''
                      }`}
                    >
                      {/* Day Header */}
                      <div className={`h-14 border-b border-border/60 flex flex-col items-center justify-center ${
                        isCurrentDay ? 'border-primary/20' : ''
                      }`}>
                        <span className={`text-[10px] font-semibold uppercase tracking-widest mb-0.5 ${
                          isCurrentDay ? 'text-primary' : 'text-muted-foreground'
                        }`}>
                          {format(day, 'EEE')}
                        </span>
                        <span className={`text-lg font-medium ${
                          isCurrentDay ? 'text-primary' : 'text-foreground/80'
                        }`}>
                          {format(day, 'd')}
                        </span>
                      </div>

                      {/* Time Slots for the day */}
                      <div className="flex-1 flex flex-col relative">
                        {timeSlots.map(time => {
                          const id = `d${colIdx}-${time}`;
                          const cellData = weekData[id];
                          const isEditing = editingCell === id;
                          const hasContent = !!cellData?.content;
                          const cellHeight = intervalOption === 60 ? 'h-24' : intervalOption === 30 ? 'h-16' : 'h-10';
                          
                          // Styling classes
                          let cellStyles = 'border-b border-border/30 transition-all duration-200 ';
                          
                          if (isEditing) {
                            cellStyles += 'bg-white ring-1 ring-primary/30 z-10 shadow-sm ';
                          } else if (hasContent) {
                            const colorClass = CELL_COLORS[cellData.color || 'sage'];
                            cellStyles += `${colorClass} border-b-[rgba(0,0,0,0.05)] shadow-[0_1px_2px_rgba(0,0,0,0.02)] `;
                          } else {
                            cellStyles += 'hover:bg-black/[0.02] ';
                          }

                          // Render content or input
                          return (
                            <div 
                              key={id}
                              className={`relative p-1.5 group cursor-text ${cellHeight} ${cellStyles}`}
                              onClick={() => handleCellClick(id)}
                              onMouseEnter={() => setHoveredCell(id)}
                              onMouseLeave={() => setHoveredCell(null)}
                            >
                              {isEditing ? (
                                <div className="h-full flex flex-col w-full relative">
                                  <textarea
                                    ref={editInputRef}
                                    value={cellData?.content || ''}
                                    onChange={(e) => updateCell(id, e.target.value, cellData?.color)}
                                    onKeyDown={(e) => handleKeyDown(e, id)}
                                    onBlur={() => setEditingCell(null)}
                                    className="w-full h-full resize-none bg-transparent outline-none text-sm text-foreground placeholder:text-muted-foreground/50 leading-snug"
                                    placeholder="Add detail..."
                                    spellCheck={false}
                                  />
                                  {/* Color picker toolbar when editing */}
                                  <div 
                                    className="absolute -bottom-10 left-1/2 -translate-x-1/2 bg-white border border-border/80 shadow-md rounded-full px-2 py-1.5 flex items-center space-x-1.5 z-50 animate-in fade-in slide-in-from-top-2 duration-200"
                                    onMouseDown={(e) => e.preventDefault()} // Prevent blur on color click
                                  >
                                    {(Object.keys(COLOR_PICKER_SWATCHES) as CellColor[]).map(color => (
                                      <button
                                        key={color}
                                        type="button"
                                        onClick={(e) => {
                                          e.preventDefault();
                                          e.stopPropagation();
                                          updateCell(id, cellData?.content || 'New item', color);
                                        }}
                                        className={`w-5 h-5 rounded-full border ${COLOR_PICKER_SWATCHES[color]} ${
                                          (cellData?.color || (hasContent ? '' : 'transparent')) === color 
                                            ? 'ring-2 ring-primary ring-offset-1' 
                                            : 'hover:scale-110 transition-transform'
                                        }`}
                                        aria-label={`Select ${color} color`}
                                      />
                                    ))}
                                  </div>
                                </div>
                              ) : (
                                <div className="w-full h-full relative overflow-hidden">
                                  {hasContent && (
                                    <>
                                      <p className="text-sm font-medium leading-snug break-words line-clamp-3">
                                        {cellData.content}
                                      </p>
                                      
                                      {/* Clear button (visible on hover) */}
                                      {hoveredCell === id && (
                                        <button
                                          onClick={(e) => clearCell(id, e)}
                                          className="absolute top-0.5 right-0.5 p-1 rounded-md text-foreground/40 hover:text-destructive hover:bg-destructive/10 transition-colors bg-white/50 backdrop-blur-sm"
                                          aria-label="Clear cell"
                                        >
                                          <X size={12} strokeWidth={2.5} />
                                        </button>
                                      )}
                                    </>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </motion.div>
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}
