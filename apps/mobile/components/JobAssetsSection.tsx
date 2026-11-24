import { useMemo, useState } from "react";
import { Alert, Pressable, StyleSheet, Text, View } from "react-native";
import { usePowerSync, useQuery } from "@powersync/react";
import { decode as decodeBase64 } from "base64-arraybuffer";
import { v4 as uuidv4 } from "uuid";
import {
  assetAgeYears,
  assetDefaults,
  assetSummary,
  serviceState,
  sydneyToday,
  type AssetDefaultService,
  type AssetDefaultWarranty,
  type AssetField,
} from "@jmssaas/shared";
import { useAuth } from "../lib/auth-context";
import { addAssetPhoto } from "../lib/powersync";
import { supabase } from "../lib/supabase";
import { getErrorMessage } from "../lib/errors";
import { useThemedStyles, type StyleTheme } from "../lib/use-themed-styles";
import { CenteredModal } from "./CenteredModal";
import { ThemedButton } from "./theme/ThemedButton";
import { ThemedFormField } from "./theme/ThemedFormField";
import { ThemedPhotoAttachments } from "./theme/ThemedPhotoAttachments";

// The client's (or agency property's) assets on the phone's job card
// (asset_register migration): tick off the services done on this job, add
// what was installed, fill in serial numbers and take data-plate photos -
// all offline through PowerSync. The database moves each service's next
// due date when a tick syncs up.

// Rows as PowerSync stores them: JSON as text, booleans as 0/1.
interface TypeRow {
  id: string;
  name: string;
  icon: string | null;
  category: string;
  fields: string | null;
  default_services: string | null;
  default_warranties: string | null;
  lead_days: number | null;
  is_archived: number | null;
}
interface AssetRow {
  id: string;
  tenant_id: string;
  client_id: string | null;
  property_id: string | null;
  site_id: string | null;
  asset_type_id: string | null;
  asset_name: string;
  attributes: string | null;
  installed_on: string | null;
  install_year: number | null;
  location: string | null;
  notes: string | null;
  needs_details: number | null;
  installed_by_job_id: string | null;
}
interface ServiceRow {
  id: string;
  asset_id: string;
  name: string;
  next_due_on: string | null;
  last_done_on: string | null;
}
interface WarrantyRow {
  id: string;
  asset_id: string;
  kind: string;
  label: string | null;
  expires_on: string | null;
}
interface SiteRow {
  id: string;
  label: string | null;
  address_line1: string | null;
  suburb: string | null;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return (JSON.parse(text) as T) ?? fallback;
  } catch {
    return fallback;
  }
}
const attrsOf = (a: AssetRow) => parseJson<Record<string, string | number | null>>(a.attributes, {});
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDay(day: string | null): string {
  if (!day) return "-";
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]} ${y}`;
}

interface Props {
  jobCardId: string;
  clientId: string | null;
  propertyId: string | null;
  siteId: string | null;
}

export function JobAssetsSection({ jobCardId, clientId, propertyId, siteId }: Props) {
  const styles = useThemedStyles(createStyles);
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const today = sydneyToday();
  const ownerColumn = propertyId ? "property_id" : "client_id";
  const ownerId = propertyId ?? clientId ?? "";

  const { data: types } = useQuery<TypeRow>("SELECT * FROM asset_types ORDER BY sort_order, name");
  const { data: assets } = useQuery<AssetRow>(`SELECT * FROM property_assets WHERE ${ownerColumn} = ? AND status = 'active' ORDER BY asset_name`, [ownerId]);
  const { data: services } = useQuery<ServiceRow>(
    `SELECT s.id, s.asset_id, s.name, s.next_due_on, s.last_done_on FROM asset_services s JOIN property_assets a ON a.id = s.asset_id
      WHERE a.${ownerColumn} = ? ORDER BY s.next_due_on`,
    [ownerId]
  );
  const { data: warranties } = useQuery<WarrantyRow>(
    `SELECT w.id, w.asset_id, w.kind, w.label, w.expires_on FROM asset_warranties w JOIN property_assets a ON a.id = w.asset_id WHERE a.${ownerColumn} = ?`,
    [ownerId]
  );
  const { data: records } = useQuery<{ id: string; service_id: string | null }>("SELECT id, service_id FROM asset_service_records WHERE job_card_id = ?", [jobCardId]);
  const { data: sites } = useQuery<SiteRow>("SELECT id, label, address_line1, suburb FROM client_sites WHERE client_id = ? ORDER BY created_at", [clientId ?? ""]);

  const [editing, setEditing] = useState<{ id: string | null } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);
  // The assets at this job's address first.
  const sorted = [...assets].sort((a, b) => Number(b.site_id === siteId) - Number(a.site_id === siteId));

  const toggle = async (asset: AssetRow, service: ServiceRow, done: boolean) => {
    if (!profile) return;
    if (done) {
      await powersync.execute(
        `INSERT INTO asset_service_records (id, tenant_id, asset_id, service_id, job_card_id, done_on, done_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [uuidv4(), asset.tenant_id, asset.id, service.id, jobCardId, today, profile.id, new Date().toISOString()]
      );
    } else {
      // A tech can only undo their own tick (an admin anyone's) - the same
      // rule the database enforces, so the untick doesn't bounce back.
      if (profile.role === "admin") {
        await powersync.execute("DELETE FROM asset_service_records WHERE job_card_id = ? AND service_id = ?", [jobCardId, service.id]);
      } else {
        const result = await powersync.execute("DELETE FROM asset_service_records WHERE job_card_id = ? AND service_id = ? AND done_by = ?", [jobCardId, service.id, profile.id]);
        if (!result.rowsAffected) Alert.alert("Ticked by someone else", "Ask an admin to untick it.");
      }
    }
  };

  const addInstalled = async () => {
    setAdding(true);
    setMessage(null);
    try {
      const { data, error } = await supabase.rpc("create_assets_from_job", { p_job_card_id: jobCardId });
      if (error) throw error;
      const count = Number(data ?? 0);
      setMessage(
        count
          ? `Added ${count} asset${count === 1 ? "" : "s"} from this job's invoice. They'll appear in a moment - fill in the serial numbers.`
          : "Nothing new to add - no invoice or accepted quote lines use a price book item marked 'creates an asset'."
      );
    } catch (e) {
      setMessage(`${getErrorMessage(e, "Couldn't add them")} (this needs signal - or add the asset by hand).`);
    } finally {
      setAdding(false);
    }
  };

  if (!ownerId) return null;
  return (
    <View>
      <View style={styles.actionsRow}>
        <Pressable onPress={() => setEditing({ id: null })}>
          <Text style={styles.addLink}>+ Add asset</Text>
        </Pressable>
        <Pressable onPress={addInstalled} disabled={adding}>
          <Text style={styles.addLink}>{adding ? "Adding..." : "Add what this job installed"}</Text>
        </Pressable>
      </View>
      {message ? <Text style={styles.message}>{message}</Text> : null}
      {sorted.length === 0 ? <Text style={styles.empty}>No assets recorded for this {propertyId ? "property" : "client"} yet.</Text> : null}
      {sorted.map((asset) => {
        const type = asset.asset_type_id ? typeById.get(asset.asset_type_id) : undefined;
        const age = assetAgeYears(asset, today);
        const summary = assetSummary({ attributes: attrsOf(asset) });
        const assetServices = services.filter((s) => s.asset_id === asset.id);
        const live = warranties.filter((w) => w.asset_id === asset.id && w.expires_on && w.expires_on >= today).sort((a, b) => (a.expires_on! < b.expires_on! ? 1 : -1))[0];
        return (
          <View key={asset.id} style={[styles.card, asset.needs_details ? styles.cardNeedsDetails : null]}>
            <Pressable onPress={() => setEditing({ id: asset.id })}>
              <Text style={styles.cardTitle}>
                {type?.icon ?? "🔧"} {asset.asset_name}
              </Text>
              <Text style={styles.meta}>{[type?.name, summary, age !== null ? `${age} yrs old` : null, asset.location].filter(Boolean).join(" · ")}</Text>
              {asset.needs_details ? <Text style={styles.warning}>Needs details - tap to add the serial number and a photo of the data plate</Text> : null}
              {live ? (
                <Text style={styles.meta}>
                  Warranty to {fmtDay(live.expires_on)}
                  {live.label ? ` (${live.label.toLowerCase()})` : ""}
                </Text>
              ) : null}
            </Pressable>
            {assetServices.map((s) => {
              const doneHere = records.some((r) => r.service_id === s.id);
              const state = serviceState(s.next_due_on, today, type?.lead_days ?? 28);
              return (
                <Pressable key={s.id} style={styles.serviceRow} onPress={() => toggle(asset, s, !doneHere)} accessibilityRole="checkbox" accessibilityState={{ checked: doneHere }}>
                  <View style={[styles.checkbox, doneHere ? styles.checkboxOn : null]}>{doneHere ? <Text style={styles.checkMark}>✓</Text> : null}</View>
                  <Text style={styles.serviceName}>{s.name}</Text>
                  <Text style={[styles.serviceDue, doneHere ? styles.ok : state === "overdue" ? styles.overdue : state === "due" ? styles.due : null]}>
                    {doneHere ? "done on this job" : s.next_due_on ? `${state === "overdue" ? "overdue" : "due"} ${fmtDay(s.next_due_on)}` : ""}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        );
      })}
      {editing ? (
        <AssetEditorModal
          assetId={editing.id}
          onClose={() => setEditing(null)}
          onCreated={(id) => setEditing({ id })}
          owner={{ column: ownerColumn, id: ownerId }}
          types={types}
          sites={propertyId ? [] : sites}
          defaultSiteId={siteId}
          jobCardId={jobCardId}
          warranties={warranties.filter((w) => w.asset_id === editing.id)}
        />
      ) : null}
    </View>
  );
}

function AssetEditorModal({
  assetId,
  onClose,
  onCreated,
  owner,
  types,
  sites,
  defaultSiteId,
  jobCardId,
  warranties,
}: {
  assetId: string | null;
  onClose: () => void;
  onCreated: (id: string) => void;
  owner: { column: "client_id" | "property_id"; id: string };
  types: TypeRow[];
  sites: SiteRow[];
  defaultSiteId: string | null;
  jobCardId: string;
  warranties: WarrantyRow[];
}) {
  const styles = useThemedStyles(createStyles);
  const powersync = usePowerSync();
  const { profile } = useAuth();
  const { data: rows } = useQuery<AssetRow>("SELECT * FROM property_assets WHERE id = ?", [assetId ?? ""]);
  const { data: photos } = useQuery<{ id: string; file_name: string | null; mime_type: string | null; local_uri: string | null; upload_state: number | null }>(
    `SELECT f.id, f.file_name, f.mime_type, a.local_uri, a.state AS upload_state
       FROM asset_files f LEFT JOIN attachments a ON a.id = f.id
      WHERE f.asset_id = ? AND f.kind = 'photo' ORDER BY f.created_at`,
    [assetId ?? ""]
  );
  const existing = rows[0] ?? null;
  const [loadedFor, setLoadedFor] = useState<string | null | undefined>(undefined);
  const [typeId, setTypeId] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [location, setLocation] = useState("");
  const [installed, setInstalled] = useState("");
  const [siteChoice, setSiteChoice] = useState<string | null>(defaultSiteId);
  const [attributes, setAttributes] = useState<Record<string, string>>({});
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(false);

  // Seed the form once the row is there (or straight away for a new one).
  if (assetId === null && loadedFor === undefined) setLoadedFor(null);
  if (assetId && existing && loadedFor !== assetId) {
    setLoadedFor(assetId);
    setTypeId(existing.asset_type_id);
    setName(existing.asset_name);
    setLocation(existing.location ?? "");
    setInstalled(existing.installed_on ?? (existing.install_year ? String(existing.install_year) : ""));
    setSiteChoice(existing.site_id);
    setAttributes(Object.fromEntries(Object.entries(attrsOf(existing)).map(([k, v]) => [k, v == null ? "" : String(v)])));
    setNotes(existing.notes ?? "");
  }

  const activeTypes = types.filter((t) => !t.is_archived || t.id === typeId);
  const type = types.find((t) => t.id === typeId) ?? null;
  const fields = parseJson<AssetField[]>(type?.fields ?? null, []);

  const save = async () => {
    if (!profile) return;
    setError(null);
    const trimmed = installed.trim();
    const isYear = /^\d{4}$/.test(trimmed);
    const isDate = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) && !Number.isNaN(Date.parse(trimmed));
    if (trimmed && !isYear && !isDate) {
      setError("Installed: a date like 2024-03-15, or just the year (2016).");
      return;
    }
    const installedOn = isDate ? trimmed : null;
    const installYear = isYear ? Number(trimmed) : null;
    const attrs: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(attributes)) {
      if (!v.trim()) continue;
      const field = fields.find((f) => f.key === k);
      attrs[k] = field?.type === "number" && Number.isFinite(Number(v)) ? Number(v) : v.trim();
    }
    const assetName = name.trim() || (attrs.brand ? `${attrs.brand}${attrs.model ? ` ${attrs.model}` : ""}` : type?.name ?? "Asset");
    const now = new Date().toISOString();
    try {
      if (existing) {
        await powersync.execute(
          `UPDATE property_assets SET asset_type_id = ?, category = ?, asset_name = ?, attributes = ?, installed_on = ?, install_year = ?, location = ?, notes = ?, site_id = ?, needs_details = 0, updated_at = ? WHERE id = ?`,
          [typeId, type?.category ?? "general", assetName, JSON.stringify(attrs), installedOn, installYear, location.trim() || null, notes.trim() || null, siteChoice, now, existing.id]
        );
        setSaved(true);
      } else {
        const id = uuidv4();
        const defaults = type
          ? assetDefaults(
              {
                default_services: parseJson<AssetDefaultService[]>(type.default_services, []),
                default_warranties: parseJson<AssetDefaultWarranty[]>(type.default_warranties, []),
              },
              installedOn ?? (installYear ? `${installYear}-07-01` : null),
              sydneyToday()
            )
          : { services: [], warranties: [] };
        await powersync.writeTransaction(async (tx) => {
          await tx.execute(
            `INSERT INTO property_assets (id, tenant_id, ${owner.column}, site_id, category, asset_type_id, asset_name, attributes, installed_on, install_year, location, notes, status, needs_details, installed_by_job_id, created_by, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, ?, ?, ?, ?)`,
            [
              id,
              profile.tenant_id,
              owner.id,
              owner.column === "client_id" ? siteChoice : null,
              type?.category ?? "general",
              typeId,
              assetName,
              JSON.stringify(attrs),
              installedOn,
              installYear,
              location.trim() || null,
              notes.trim() || null,
              // Installed today on this job? Then it's this job's install.
              installedOn === sydneyToday() ? jobCardId : null,
              profile.id,
              now,
              now,
            ]
          );
          for (const s of defaults.services) {
            await tx.execute(
              "INSERT INTO asset_services (id, tenant_id, asset_id, name, interval_months, next_due_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
              [uuidv4(), profile.tenant_id, id, s.name, s.interval_months, s.next_due_on, now]
            );
          }
          for (const w of defaults.warranties) {
            await tx.execute(
              "INSERT INTO asset_warranties (id, tenant_id, asset_id, kind, label, starts_on, expires_on, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
              [uuidv4(), profile.tenant_id, id, w.kind, w.label, w.starts_on, w.expires_on, now]
            );
          }
        });
        setSaved(true);
        onCreated(id);
      }
    } catch (e) {
      setError(getErrorMessage(e, "Couldn't save"));
    }
  };

  const markRemoved = () => {
    if (!existing) return;
    Alert.alert("Removed or replaced?", "It stays in the history but drops off the reminders.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Mark removed",
        style: "destructive",
        onPress: async () => {
          await powersync.execute("UPDATE property_assets SET status = 'removed', removed_on = ?, updated_at = ? WHERE id = ?", [sydneyToday(), new Date().toISOString(), existing.id]);
          onClose();
        },
      },
    ]);
  };

  const uploadPhoto = async (photo: { base64: string; mimeType: string; fileExtension: string }) => {
    if (!profile || !existing) return;
    setUploading(true);
    try {
      await addAssetPhoto({
        tenantId: profile.tenant_id,
        assetId: existing.id,
        uploadedBy: profile.id,
        imageArrayBuffer: decodeBase64(photo.base64),
        mediaType: photo.mimeType,
        fileExtension: photo.fileExtension,
      });
    } finally {
      setUploading(false);
    }
  };

  return (
    <CenteredModal visible onClose={onClose}>
      <Text style={styles.modalTitle}>{existing ? existing.asset_name : "Add asset"}</Text>
      <Text style={styles.fieldLabel}>Type</Text>
      <View style={styles.chips}>
        {activeTypes.map((t) => (
          <Pressable key={t.id} style={[styles.chip, t.id === typeId ? styles.chipOn : null]} onPress={() => setTypeId(t.id)}>
            <Text style={[styles.chipText, t.id === typeId ? styles.chipTextOn : null]}>
              {t.icon ?? ""} {t.name}
            </Text>
          </Pressable>
        ))}
      </View>
      <ThemedFormField label="Name" value={name} onChangeText={setName} placeholder={type?.name ?? "e.g. Hot water system"} />
      {sites.length > 0 ? (
        <>
          <Text style={styles.fieldLabel}>Address</Text>
          <View style={styles.chips}>
            {[{ id: null as string | null, text: "Main address" }, ...sites.map((s) => ({ id: s.id as string | null, text: s.label || [s.address_line1, s.suburb].filter(Boolean).join(", ") }))].map((s) => (
              <Pressable key={s.id ?? "main"} style={[styles.chip, s.id === siteChoice ? styles.chipOn : null]} onPress={() => setSiteChoice(s.id)}>
                <Text style={[styles.chipText, s.id === siteChoice ? styles.chipTextOn : null]}>{s.text}</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
      <ThemedFormField label="Where on site" value={location} onChangeText={setLocation} placeholder="e.g. Side of house, laundry" />
      <ThemedFormField label="Installed (date or year)" value={installed} onChangeText={setInstalled} placeholder={`${sydneyToday()} or 2016`} autoCapitalize="none" />
      {fields.map((f) =>
        f.type === "select" ? (
          <View key={f.key}>
            <Text style={styles.fieldLabel}>{f.label}</Text>
            <View style={styles.chips}>
              {(f.options ?? []).map((o) => (
                <Pressable key={o} style={[styles.chip, attributes[f.key] === o ? styles.chipOn : null]} onPress={() => setAttributes((a) => ({ ...a, [f.key]: a[f.key] === o ? "" : o }))}>
                  <Text style={[styles.chipText, attributes[f.key] === o ? styles.chipTextOn : null]}>{o}</Text>
                </Pressable>
              ))}
            </View>
          </View>
        ) : (
          <ThemedFormField
            key={f.key}
            label={f.label}
            value={attributes[f.key] ?? ""}
            onChangeText={(v) => setAttributes((a) => ({ ...a, [f.key]: v }))}
            keyboardType={f.type === "number" ? "decimal-pad" : "default"}
            placeholder={f.type === "date" ? "YYYY-MM-DD" : undefined}
            autoCapitalize={f.key === "serial_number" ? "characters" : "sentences"}
          />
        )
      )}
      <ThemedFormField label="Notes" value={notes} onChangeText={setNotes} multiline />
      {existing && warranties.length ? (
        <View style={styles.block}>
          <Text style={styles.fieldLabel}>Warranties</Text>
          {warranties.map((w) => (
            <Text key={w.id} style={styles.meta}>
              {w.kind === "workmanship" ? "Workmanship" : w.label || "Manufacturer"}: {w.expires_on ? `to ${fmtDay(w.expires_on)}` : "dates not set"}
            </Text>
          ))}
          <Text style={styles.meta}>Change warranties and claims on the desktop.</Text>
        </View>
      ) : null}
      {existing ? (
        <View style={styles.block}>
          <Text style={styles.fieldLabel}>Photos (data plate, the install)</Text>
          <ThemedPhotoAttachments photos={photos} uploading={uploading} onUpload={uploadPhoto} />
        </View>
      ) : (
        <Text style={styles.meta}>Save first, then add photos.</Text>
      )}
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {saved ? <Text style={styles.message}>Saved.</Text> : null}
      <View style={styles.buttons}>
        <ThemedButton label={existing ? "Save" : "Add asset"} onPress={save} />
        <ThemedButton label="Close" variant="secondary" onPress={onClose} />
      </View>
      {existing ? (
        <Pressable onPress={markRemoved} style={{ marginTop: 12 }}>
          <Text style={styles.removeLink}>Removed or replaced?</Text>
        </Pressable>
      ) : null}
    </CenteredModal>
  );
}

function createStyles({ tokens, font, fontFamily }: StyleTheme) {
  const mono = { fontFamily: fontFamily.mobileFontFamily };
  return StyleSheet.create({
    actionsRow: { flexDirection: "row", flexWrap: "wrap", gap: 16, marginBottom: 10 },
    addLink: { color: tokens.accent, fontWeight: "600", fontSize: font.label, ...mono },
    message: { color: tokens.accent, fontSize: font.body - 2, marginBottom: 8, ...mono },
    empty: { color: tokens.textMuted, fontSize: font.body - 1, marginBottom: 8, ...mono },
    card: { borderWidth: 1, borderColor: tokens.border, borderRadius: 10, padding: 12, marginBottom: 10, backgroundColor: tokens.surface },
    cardNeedsDetails: { borderColor: tokens.warning },
    cardTitle: { color: tokens.accent, fontWeight: "700", fontSize: font.body, ...mono },
    meta: { color: tokens.textMuted, fontSize: font.label, marginTop: 2, ...mono },
    warning: { color: tokens.warning, fontSize: font.label, marginTop: 4, ...mono },
    serviceRow: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 },
    checkbox: { width: 24, height: 24, borderRadius: 5, borderWidth: 1.5, borderColor: tokens.border, alignItems: "center", justifyContent: "center" },
    checkboxOn: { backgroundColor: tokens.accentGlow, borderColor: tokens.accent },
    checkMark: { color: tokens.accent, fontWeight: "700", fontSize: font.body - 1 },
    serviceName: { color: tokens.textPrimary, fontSize: font.body - 1, flexShrink: 1, ...mono },
    serviceDue: { color: tokens.textMuted, fontSize: font.label, marginLeft: "auto", ...mono },
    ok: { color: tokens.accent },
    due: { color: tokens.warning },
    overdue: { color: tokens.danger },
    modalTitle: { fontSize: font.title - 2, fontWeight: "700", color: tokens.accent, marginBottom: 10, textTransform: "uppercase", letterSpacing: 1, ...mono },
    fieldLabel: { fontSize: font.label - 1, fontWeight: "700", textTransform: "uppercase", color: tokens.textMuted, marginBottom: 6, ...mono },
    chips: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginBottom: 12 },
    chip: { borderWidth: 1, borderColor: tokens.border, borderRadius: 14, paddingHorizontal: 10, paddingVertical: 6, backgroundColor: tokens.background },
    chipOn: { borderColor: tokens.accent, backgroundColor: tokens.accentGlow },
    chipText: { color: tokens.textPrimary, fontSize: font.label, ...mono },
    chipTextOn: { color: tokens.accent, fontWeight: "700" },
    block: { marginBottom: 12 },
    error: { color: tokens.danger, fontSize: font.body - 2, marginVertical: 4, ...mono },
    buttons: { flexDirection: "row", gap: 10, marginTop: 8 },
    removeLink: { color: tokens.danger, fontSize: font.label, fontWeight: "600", ...mono },
  });
}
