
function niceTime(iso: string): string {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function DayDetail({
  date,
  sessions,
  dayStartHour,
  onClose,
  onEditTotal,
  onEditSession,
}: {
  date: string;
  sessions: FocusSessionRecord[];
  dayStartHour: number;
  onClose: () => void;
  onEditTotal: (secs: number) => void;
  onEditSession: (id: string, secs: number) => void;
}) {
  const p = useTheme();
  
  const daySessions = sessions
    .filter(s => s && focusDayKey(s.endedAt ?? s.startedAt, dayStartHour) === date && s.durationSeconds >= 60)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    
  const total = daySessions.reduce((sum, s) => sum + s.durationSeconds, 0);

  const [editingTotal, setEditingTotal] = useState(false);
  const [totalMins, setTotalMins] = useState(Math.round(total / 60));

  return (
    <View style={{
      marginTop: space.xl,
      padding: space.lg,
      borderRadius: radius.lg,
      backgroundColor: p.surfaceAlt,
      borderWidth: 1,
      borderColor: p.line,
    }}>
      <Row style={{ justifyContent: 'space-between', marginBottom: space.md }}>
        <Text variant="title">{niceDate(date)}</Text>
        <Pressable onPress={onClose} style={{ padding: 4 }}>
          <Text variant="bodyStrong" tone="accent">Close</Text>
        </Pressable>
      </Row>

      {editingTotal ? (
        <View style={{ marginBottom: space.lg, gap: space.sm }}>
          <Text variant="caption" tone="faint">TOTAL FOCUS TIME</Text>
          <Stepper
            value={totalMins}
            onChange={setTotalMins}
            min={0}
            max={1440}
            step={5}
            format={(v) => describeDuration(v * 60)}
          />
          <Row gap={space.sm}>
             <Pressable
               onPress={() => setEditingTotal(false)}
               style={{ flex: 1, padding: space.sm, alignItems: 'center', borderRadius: radius.md, backgroundColor: p.surface }}
             ><Text variant="bodyStrong">Cancel</Text></Pressable>
             <Pressable
               onPress={() => { onEditTotal(totalMins * 60); setEditingTotal(false); }}
               style={{ flex: 1, padding: space.sm, alignItems: 'center', borderRadius: radius.md, backgroundColor: p.accent }}
             ><Text variant="bodyStrong" style={{ color: p.accentInk }}>Save Total</Text></Pressable>
          </Row>
        </View>
      ) : (
        <Row style={{ justifyContent: 'space-between', marginBottom: space.lg, paddingBottom: space.sm, borderBottomWidth: 1, borderBottomColor: p.line }}>
          <Text variant="bodyStrong">{describeDuration(total)}</Text>
          <Pressable onPress={() => { setTotalMins(Math.round(total / 60)); setEditingTotal(true); }}>
            <Text variant="bodyStrong" tone="accent">Edit Total</Text>
          </Pressable>
        </Row>
      )}

      <Text variant="caption" tone="faint" style={{ marginBottom: space.sm }}>SESSIONS</Text>
      {daySessions.length === 0 ? (
        <Text variant="body" tone="soft">No sessions recorded.</Text>
      ) : (
        <View style={{ gap: space.sm }}>
          {daySessions.map(s => (
            <Row key={s.id} style={{ justifyContent: 'space-between', backgroundColor: p.surface, padding: space.md, borderRadius: radius.md }}>
              <View>
                <Text variant="bodyStrong">{describeDuration(s.durationSeconds)}</Text>
                <Text variant="caption" tone="soft">{niceTime(s.startedAt)} - {niceTime(s.endedAt ?? s.startedAt)}</Text>
              </View>
              <Pressable onPress={() => onEditSession(s.id, 0)} style={{ padding: space.xs }}>
                <Text variant="bodyStrong" tone="danger">Delete</Text>
              </Pressable>
            </Row>
          ))}
        </View>
      )}
    </View>
  );
}
