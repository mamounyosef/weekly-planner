import React, { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  ScrollView,
  View,
  useWindowDimensions,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Text } from '../ui/kit';
import { ICONS } from '../ui/icons';
import { radius, space, type Palette } from '../theme';
import { attachmentSource } from '../lib/agent/agentApi';

export interface PreviewItem {
  uri?: string;
  id?: string;
  name?: string;
  localId?: string;
}

const SKY = '#0ea5e9';

function Icon({ name, size = 20, color }: { name: string; size?: number; color: string }) {
  const src = ICONS[name];
  if (!src) return null;
  return <Image source={{ uri: src }} style={{ width: size, height: size, tintColor: color }} />;
}

function IconButton({
  name,
  onPress,
  color,
  bg,
  size = 20,
  label,
}: {
  name: string;
  onPress: () => void;
  color: string;
  bg?: string;
  size?: number;
  label: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityLabel={label}
      hitSlop={8}
      style={({ pressed }) => ({
        width: 38,
        height: 38,
        borderRadius: 19,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: bg ?? 'transparent',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Icon name={name} size={size} color={color} />
    </Pressable>
  );
}

function PreviewImageLoader({
  item,
  width,
  height,
}: {
  item: PreviewItem;
  width: number;
  height: number;
}) {
  const [src, setSrc] = useState<{ uri: string; headers?: Record<string, string> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (item.uri) {
      setSrc({ uri: item.uri });
    } else if (item.id) {
      attachmentSource(item.id)
        .then(s => {
          if (!cancelled) setSrc(s);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [item.uri, item.id]);

  if (!src) {
    return (
      <View style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
        <ActivityIndicator color="#fff" size="large" />
      </View>
    );
  }

  return (
    <Image
      source={src}
      style={{ width, height }}
      resizeMode="contain"
    />
  );
}

function ThumbnailLoader({ item }: { item: PreviewItem }) {
  const [src, setSrc] = useState<{ uri: string; headers?: Record<string, string> } | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (item.uri) {
      setSrc({ uri: item.uri });
    } else if (item.id) {
      attachmentSource(item.id)
        .then(s => {
          if (!cancelled) setSrc(s);
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [item.uri, item.id]);

  if (!src) {
    return <View style={{ width: 44, height: 44, backgroundColor: 'rgba(255,255,255,0.1)' }} />;
  }

  return (
    <Image
      source={src}
      style={{ width: 44, height: 44 }}
      resizeMode="cover"
    />
  );
}

export function PhoneImagePreviewModal({
  visible,
  items,
  initialIndex,
  onClose,
  onRemove,
}: {
  visible: boolean;
  items: PreviewItem[];
  initialIndex: number;
  onClose: () => void;
  onRemove?: (localId: string) => void;
  p: Palette;
}) {
  const insets = useSafeAreaInsets();
  const { width: winWidth, height: winHeight } = useWindowDimensions();
  const [index, setIndex] = useState(() => Math.max(0, Math.min(initialIndex, items.length - 1)));
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    setIndex(Math.max(0, Math.min(initialIndex, items.length - 1)));
  }, [initialIndex, visible]);

  useEffect(() => {
    setZoomed(false);
  }, [index]);

  useEffect(() => {
    if (items.length === 0 && visible) {
      onClose();
    } else if (index >= items.length) {
      setIndex(Math.max(0, items.length - 1));
    }
  }, [items.length, index, visible, onClose]);

  const current = items[index];
  if (!visible || !current) return null;

  const handlePrev = () => {
    if (items.length <= 1) return;
    setIndex(i => (i > 0 ? i - 1 : items.length - 1));
  };

  const handleNext = () => {
    if (items.length <= 1) return;
    setIndex(i => (i < items.length - 1 ? i + 1 : 0));
  };

  const handleRemove = () => {
    if (!current?.localId || !onRemove) return;
    onRemove(current.localId);
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={{ flex: 1, backgroundColor: 'rgba(5, 7, 12, 0.95)' }}>
        {/* Top Header */}
        <View
          style={{
            paddingTop: insets.top + space.xs,
            paddingHorizontal: space.md,
            paddingBottom: space.sm,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            zIndex: 10,
            backgroundColor: 'rgba(0, 0, 0, 0.5)',
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm, flex: 1, marginRight: space.sm }}>
            <IconButton
              name="x"
              label="Close preview"
              color="#fff"
              bg="rgba(255, 255, 255, 0.15)"
              size={18}
              onPress={onClose}
            />
            <View style={{ flex: 1 }}>
              <Text variant="bodyStrong" numberOfLines={1} style={{ color: '#fff' }}>
                {current.name || (items.length > 1 ? `Image ${index + 1}` : 'Image preview')}
              </Text>
              {items.length > 1 && (
                <Text variant="caption" style={{ color: 'rgba(255, 255, 255, 0.6)' }}>
                  {index + 1} of {items.length}
                </Text>
              )}
            </View>
          </View>

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
            {/* Zoom toggle button */}
            <Pressable
              onPress={() => setZoomed(z => !z)}
              hitSlop={8}
              style={{
                paddingHorizontal: 11,
                paddingVertical: 6,
                borderRadius: 16,
                backgroundColor: zoomed ? SKY : 'rgba(255, 255, 255, 0.18)',
                marginRight: 4,
              }}
            >
              <Text variant="caption" style={{ color: '#fff', fontWeight: '700' }}>
                {zoomed ? '2.5x' : 'Fit'}
              </Text>
            </Pressable>

            {/* Trash button if previewing pending attachment */}
            {current.localId && onRemove && (
              <IconButton
                name="trash-2"
                label="Remove image"
                color="#ef4444"
                bg="rgba(239, 68, 68, 0.18)"
                size={18}
                onPress={handleRemove}
              />
            )}
          </View>
        </View>

        {/* Image Content Area */}
        <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center' }}>
          <ScrollView
            maximumZoomScale={4}
            minimumZoomScale={1}
            centerContent
            showsHorizontalScrollIndicator={false}
            showsVerticalScrollIndicator={false}
            contentContainerStyle={{
              flexGrow: 1,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Pressable onPress={() => setZoomed(z => !z)}>
              <PreviewImageLoader
                item={current}
                width={zoomed ? winWidth * 2.2 : winWidth}
                height={zoomed ? winHeight * 1.5 : winHeight * 0.72}
              />
            </Pressable>
          </ScrollView>

          {/* Navigation Arrows for Multiple Images */}
          {items.length > 1 && (
            <>
              <Pressable
                onPress={handlePrev}
                hitSlop={12}
                style={({ pressed }) => ({
                  position: 'absolute',
                  left: space.md,
                  top: '50%',
                  marginTop: -20,
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  backgroundColor: 'rgba(0, 0, 0, 0.65)',
                  borderWidth: 1,
                  borderColor: 'rgba(255, 255, 255, 0.2)',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <View style={{ transform: [{ rotate: '180deg' }] }}>
                  <Icon name="chevron-right" size={20} color="#fff" />
                </View>
              </Pressable>

              <Pressable
                onPress={handleNext}
                hitSlop={12}
                style={({ pressed }) => ({
                  position: 'absolute',
                  right: space.md,
                  top: '50%',
                  marginTop: -20,
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  backgroundColor: 'rgba(0, 0, 0, 0.65)',
                  borderWidth: 1,
                  borderColor: 'rgba(255, 255, 255, 0.2)',
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Icon name="chevron-right" size={20} color="#fff" />
              </Pressable>
            </>
          )}
        </View>

        {/* Bottom thumbnail strip or hint */}
        {items.length > 1 ? (
          <View
            style={{
              paddingBottom: insets.bottom + space.sm,
              paddingTop: space.sm,
              paddingHorizontal: space.md,
              backgroundColor: 'rgba(0, 0, 0, 0.65)',
              alignItems: 'center',
            }}
          >
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space.sm }}>
              {items.map((it, idx) => (
                <Pressable
                  key={it.localId ?? it.id ?? idx}
                  onPress={() => setIndex(idx)}
                  style={{
                    width: 46,
                    height: 46,
                    borderRadius: radius.sm,
                    overflow: 'hidden',
                    borderWidth: 2,
                    borderColor: idx === index ? SKY : 'transparent',
                    opacity: idx === index ? 1 : 0.6,
                  }}
                >
                  <ThumbnailLoader item={it} />
                </Pressable>
              ))}
            </ScrollView>
          </View>
        ) : (
          <View
            style={{
              paddingBottom: insets.bottom + space.md,
              paddingTop: space.sm,
              alignItems: 'center',
            }}
          >
            <Text variant="caption" style={{ color: 'rgba(255, 255, 255, 0.45)' }}>
              Tap to zoom &bull; Pinch for detail &bull; Tap close to exit
            </Text>
          </View>
        )}
      </View>
    </Modal>
  );
}
