import React, { useRef, useState } from 'react';
import { View, Animated, PanResponder, LayoutChangeEvent } from 'react-native';

export function SortableList<T>({
  data,
  renderItem,
  onReorder,
}: {
  data: T[];
  renderItem: (item: T, index: number, isDragging: boolean, onDragStart: () => void) => React.ReactNode;
  onReorder: (from: number, to: number) => void;
}) {
  const [active, setActive] = useState<number | null>(null);
  const dragRef = useRef<number | null>(null);
  const pan = useRef(new Animated.Value(0)).current;
  const layouts = useRef<{ y: number; height: number }[]>([]);

  const startDrag = (index: number) => {
    dragRef.current = index;
    setActive(index);
    pan.setValue(0);
  };

  const finishDrag = () => {
    dragRef.current = null;
    setActive(null);
    pan.setValue(0);
  };

  const responder = useRef(PanResponder.create({
    onStartShouldSetPanResponderCapture: () => false,
    onMoveShouldSetPanResponderCapture: (_, g) => {
      return dragRef.current !== null && Math.abs(g.dy) > 2;
    },
    onPanResponderGrant: () => {
      pan.setValue(0);
    },
    onPanResponderMove: Animated.event([null, { dy: pan }], { useNativeDriver: false }),
    onPanResponderRelease: (_, g) => {
      const activeIdx = dragRef.current;
      if (activeIdx === null) return finishDrag();

      const l = layouts.current[activeIdx];
      if (!l) return finishDrag();

      const finalCenterY = l.y + (l.height / 2) + g.dy;
      
      let dropIdx = activeIdx;
      let minDiff = Infinity;
      for (let i = 0; i < data.length; i++) {
        const cl = layouts.current[i];
        if (!cl) continue;
        const cy = cl.y + (cl.height / 2);
        const diff = Math.abs(finalCenterY - cy);
        if (diff < minDiff) {
          minDiff = diff;
          dropIdx = i;
        }
      }

      if (dropIdx !== activeIdx) {
        onReorder(activeIdx, dropIdx);
      }
      finishDrag();
    },
    onPanResponderTerminate: () => finishDrag(),
  })).current;

  return (
    <View {...responder.panHandlers}>
      {data.map((item, index) => {
        const isDragging = active === index;
        return (
          <Animated.View
            key={index}
            onLayout={(e: LayoutChangeEvent) => {
              layouts.current[index] = {
                y: e.nativeEvent.layout.y,
                height: e.nativeEvent.layout.height,
              };
            }}
            style={isDragging ? {
              zIndex: 100,
              elevation: 10,
              transform: [{ translateY: pan }]
            } : {
              zIndex: 1
            }}
          >
            {renderItem(item, index, isDragging, () => startDrag(index))}
          </Animated.View>
        );
      })}
    </View>
  );
}
