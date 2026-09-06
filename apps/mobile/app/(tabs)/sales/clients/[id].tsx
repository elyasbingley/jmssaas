import { useState } from "react";
import { FlatList, Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { usePowerSync, useQuery } from "@powersync/react";
import { v4 as uuidv4 } from "uuid";
import {
  createClientContactSchema,
  createClientSchema,
  createClientSiteSchema,
  createJobCardSchema,
  type Client,
  type ClientContact,
  type ClientSite,
  type ClientType,
  type JobCard,
  type JobLifecycleStage,
} from "@jmssaas/shared";
import { useAuth } from "../../../../lib/auth-context";
import { formatClientAddress } from "../../../../lib/format";
import { CenteredModal } from "../../../../components/CenteredModal";
import { CommunicationLog } from "../../../../components/CommunicationLog";
import { FormField } from "../../../../components/FormField";
import { MembershipStatusCard } from "../../../../components/MembershipStatusCard";

export default function ClientDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const powersync = usePowerSync();
  const { profile } = useAuth();

  const { data: clientRows } = useQuery<Client>("SELECT * FROM clients WHERE id = ?", [id]);
  const client = clientRows[0];
  const { data: jobCards } = useQuery<JobCard>(
    "SELECT * FROM job_cards WHERE client_id = ? ORDER BY created_at DESC",
    [id]
  );
  const { data: stages } = useQuery<JobLifecycleStage>("SELECT * FROM job_lifecycle_stages ORDER BY position");
  const stageById = new Map(stages.map((s) => [s.id, s]));

  const { data: contacts } = useQuery<ClientContact>(
    "SELECT * FROM client_contacts WHERE client_id = ? ORDER BY is_primary DESC, name",
    [id]
  );
  const { data: sites } = useQuery<ClientSite>(
    "SELECT * FROM client_sites WHERE client_id = ? ORDER BY is_primary DESC, label",
    [id]
  );

  const [modalVisible, setModalVisible] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [formError, setFormError] = useState<string | null>(null);

  const handleCreate = async () => {
    const result = createJobCardSchema.safeParse({ client_id: id, title, description });
    if (!result.success) {
      setFormError(result.error.issues[0]?.message ?? "Invalid job");
      return;
    }
    if (!profile) return;

    const jobId = uuidv4();
    const now = new Date().toISOString();
    await powersync.execute(
      `INSERT INTO job_cards (id, tenant_id, client_id, title, description, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [jobId, profile.tenant_id, id, result.data.title, result.data.description || null, profile.id, now, now]
    );

    setTitle("");
    setDescription("");
    setFormError(null);
    setModalVisible(false);
    router.push(`/sales/jobs/${jobId}`);
  };

  // --- Edit client ---
  const [editModalVisible, setEditModalVisible] = useState(false);
  const [editClientType, setEditClientType] = useState<ClientType>("individual");
  const [editCompanyName, setEditCompanyName] = useState("");
  const [editName, setEditName] = useState("");
  const [editPhone, setEditPhone] = useState("");
  const [editEmail, setEditEmail] = useState("");
  const [editAddressLine1, setEditAddressLine1] = useState("");
  const [editAddressLine2, setEditAddressLine2] = useState("");
  const [editSuburb, setEditSuburb] = useState("");
  const [editState, setEditState] = useState("");
  const [editPostcode, setEditPostcode] = useState("");
  const [editNotes, setEditNotes] = useState("");
  const [editError, setEditError] = useState<string | null>(null);

  const openEditModal = () => {
    if (!client) return;
    setEditClientType(client.client_type ?? "individual");
    setEditCompanyName(client.company_name ?? "");
    setEditName(client.name);
    setEditPhone(client.phone ?? "");
    setEditEmail(client.email ?? "");
    setEditAddressLine1(client.address_line1 ?? "");
    setEditAddressLine2(client.address_line2 ?? "");
    setEditSuburb(client.suburb ?? "");
    setEditState(client.state ?? "");
    setEditPostcode(client.postcode ?? "");
    setEditNotes(client.notes ?? "");
    setEditError(null);
    setEditModalVisible(true);
  };

  const handleSaveEdit = async () => {
    const result = createClientSchema.safeParse({
      client_type: editClientType,
      company_name: editCompanyName,
      name: editName,
      phone: editPhone,
      email: editEmail,
      address_line1: editAddressLine1,
      address_line2: editAddressLine2,
      suburb: editSuburb,
      state: editState,
      postcode: editPostcode,
      notes: editNotes,
    });
    if (!result.success) {
      setEditError(result.error.issues[0]?.message ?? "Invalid client");
      return;
    }

    await powersync.execute(
      `UPDATE clients
          SET client_type = ?, company_name = ?, name = ?, phone = ?, email = ?, address_line1 = ?, address_line2 = ?,
              suburb = ?, state = ?, postcode = ?, notes = ?, updated_at = ?
        WHERE id = ?`,
      [
        result.data.client_type,
        result.data.company_name || null,
        result.data.name,
        result.data.phone || null,
        result.data.email || null,
        result.data.address_line1 || null,
        result.data.address_line2 || null,
        result.data.suburb || null,
        result.data.state || null,
        result.data.postcode || null,
        result.data.notes || null,
        new Date().toISOString(),
        id,
      ]
    );

    setEditModalVisible(false);
  };

  // --- Contacts (client_contacts) ---
  const [contactModalVisible, setContactModalVisible] = useState(false);
  const [editingContact, setEditingContact] = useState<ClientContact | null>(null);
  const [contactName, setContactName] = useState("");
  const [contactRole, setContactRole] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactIsPrimary, setContactIsPrimary] = useState(false);
  const [contactError, setContactError] = useState<string | null>(null);

  const openNewContact = () => {
    setEditingContact(null);
    setContactName("");
    setContactRole("");
    setContactPhone("");
    setContactEmail("");
    setContactIsPrimary(false);
    setContactError(null);
    setContactModalVisible(true);
  };

  const openEditContact = (contact: ClientContact) => {
    setEditingContact(contact);
    setContactName(contact.name);
    setContactRole(contact.role ?? "");
    setContactPhone(contact.phone ?? "");
    setContactEmail(contact.email ?? "");
    setContactIsPrimary(contact.is_primary);
    setContactError(null);
    setContactModalVisible(true);
  };

  const handleSaveContact = async () => {
    const result = createClientContactSchema.safeParse({
      client_id: id,
      name: contactName,
      role: contactRole,
      email: contactEmail,
      phone: contactPhone,
      is_primary: contactIsPrimary,
    });
    if (!result.success) {
      setContactError(result.error.issues[0]?.message ?? "Invalid contact");
      return;
    }
    if (!profile) return;

    if (editingContact) {
      await powersync.execute(
        "UPDATE client_contacts SET name = ?, role = ?, email = ?, phone = ?, is_primary = ? WHERE id = ?",
        [result.data.name, result.data.role || null, result.data.email || null, result.data.phone || null, result.data.is_primary ? 1 : 0, editingContact.id]
      );
    } else {
      await powersync.execute(
        `INSERT INTO client_contacts (id, tenant_id, client_id, name, role, email, phone, is_primary, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          profile.tenant_id,
          result.data.client_id,
          result.data.name,
          result.data.role || null,
          result.data.email || null,
          result.data.phone || null,
          result.data.is_primary ? 1 : 0,
          new Date().toISOString(),
        ]
      );
    }
    setContactModalVisible(false);
  };

  const handleDeleteContact = async () => {
    if (!editingContact) return;
    await powersync.execute("DELETE FROM client_contacts WHERE id = ?", [editingContact.id]);
    setContactModalVisible(false);
  };

  // --- Addresses (client_sites) ---
  const [siteModalVisible, setSiteModalVisible] = useState(false);
  const [editingSite, setEditingSite] = useState<ClientSite | null>(null);
  const [siteLabel, setSiteLabel] = useState("");
  const [siteAddressLine1, setSiteAddressLine1] = useState("");
  const [siteAddressLine2, setSiteAddressLine2] = useState("");
  const [siteSuburb, setSiteSuburb] = useState("");
  const [siteState, setSiteState] = useState("");
  const [sitePostcode, setSitePostcode] = useState("");
  const [siteIsPrimary, setSiteIsPrimary] = useState(false);
  const [siteNotes, setSiteNotes] = useState("");
  const [siteError, setSiteError] = useState<string | null>(null);

  const openNewSite = () => {
    setEditingSite(null);
    setSiteLabel("");
    setSiteAddressLine1("");
    setSiteAddressLine2("");
    setSiteSuburb("");
    setSiteState("");
    setSitePostcode("");
    setSiteIsPrimary(false);
    setSiteNotes("");
    setSiteError(null);
    setSiteModalVisible(true);
  };

  const openEditSite = (site: ClientSite) => {
    setEditingSite(site);
    setSiteLabel(site.label ?? "");
    setSiteAddressLine1(site.address_line1);
    setSiteAddressLine2(site.address_line2 ?? "");
    setSiteSuburb(site.suburb);
    setSiteState(site.state);
    setSitePostcode(site.postcode);
    setSiteIsPrimary(site.is_primary);
    setSiteNotes(site.notes ?? "");
    setSiteError(null);
    setSiteModalVisible(true);
  };

  const handleSaveSite = async () => {
    const result = createClientSiteSchema.safeParse({
      client_id: id,
      label: siteLabel,
      address_line1: siteAddressLine1,
      address_line2: siteAddressLine2,
      suburb: siteSuburb,
      state: siteState,
      postcode: sitePostcode,
      is_primary: siteIsPrimary,
      notes: siteNotes,
    });
    if (!result.success) {
      setSiteError(result.error.issues[0]?.message ?? "Invalid address");
      return;
    }
    if (!profile) return;

    if (editingSite) {
      await powersync.execute(
        `UPDATE client_sites SET label = ?, address_line1 = ?, address_line2 = ?, suburb = ?, state = ?,
           postcode = ?, is_primary = ?, notes = ? WHERE id = ?`,
        [
          result.data.label || null,
          result.data.address_line1,
          result.data.address_line2 || null,
          result.data.suburb,
          result.data.state,
          result.data.postcode,
          result.data.is_primary ? 1 : 0,
          result.data.notes || null,
          editingSite.id,
        ]
      );
    } else {
      await powersync.execute(
        `INSERT INTO client_sites (id, tenant_id, client_id, label, address_line1, address_line2, suburb, state, postcode, is_primary, notes, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          uuidv4(),
          profile.tenant_id,
          result.data.client_id,
          result.data.label || null,
          result.data.address_line1,
          result.data.address_line2 || null,
          result.data.suburb,
          result.data.state,
          result.data.postcode,
          result.data.is_primary ? 1 : 0,
          result.data.notes || null,
          new Date().toISOString(),
        ]
      );
    }
    setSiteModalVisible(false);
  };

  const handleDeleteSite = async () => {
    if (!editingSite) return;
    await powersync.execute("DELETE FROM client_sites WHERE id = ?", [editingSite.id]);
    setSiteModalVisible(false);
  };

  if (!client) {
    return (
      <View style={styles.container}>
        <Text style={styles.empty}>Loading...</Text>
      </View>
    );
  }

  const address = formatClientAddress(client);

  return (
    <View style={styles.container}>
      <FlatList
        data={jobCards}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <Pressable style={styles.row} onPress={() => router.push(`/sales/jobs/${item.id}`)}>
            <View style={{ flex: 1 }}>
              <View style={styles.rowTitleRow}>
                <Text style={styles.rowNumber}>{item.number ?? "Pending sync"}</Text>
                <Text style={styles.rowTitle}>{item.title}</Text>
              </View>
            </View>
            {stageById.get(item.lifecycle_stage_id ?? "") ? (
              <Text style={styles.rowSubtitle}>{stageById.get(item.lifecycle_stage_id ?? "")!.name}</Text>
            ) : null}
          </Pressable>
        )}
        ListHeaderComponent={
          <>
            <View style={styles.clientHeader}>
              <View style={styles.clientHeaderRow}>
                <Text style={styles.clientName}>
                  {client.client_type === "company" && client.company_name ? client.company_name : client.name}
                </Text>
                <Pressable onPress={openEditModal}>
                  <Text style={styles.link}>Edit</Text>
                </Pressable>
              </View>
              {client.client_type === "company" && client.company_name ? (
                <Text style={styles.clientMeta}>{client.name}</Text>
              ) : null}
              {client.phone ? <Text style={styles.clientMeta}>{client.phone}</Text> : null}
              {client.email ? <Text style={styles.clientMeta}>{client.email}</Text> : null}
              {address ? <Text style={styles.clientMeta}>{address}</Text> : null}
              {client.notes ? <Text style={styles.clientNotes}>{client.notes}</Text> : null}
            </View>

            <View style={styles.subSection}>
              <View style={styles.subSectionHeader}>
                <Text style={styles.sectionTitle}>Contacts</Text>
                <Pressable onPress={openNewContact}>
                  <Text style={styles.link}>+ Add contact</Text>
                </Pressable>
              </View>
              {contacts.length === 0 ? (
                <Text style={styles.emptySmall}>No additional contacts on file.</Text>
              ) : (
                contacts.map((contact) => (
                  <Pressable key={contact.id} style={styles.subRow} onPress={() => openEditContact(contact)}>
                    <Text style={styles.subRowTitle}>
                      {contact.name}
                      {contact.is_primary ? " (Primary)" : ""}
                      {contact.role ? ` - ${contact.role}` : ""}
                    </Text>
                    {contact.phone ? <Text style={styles.subRowMeta}>{contact.phone}</Text> : null}
                    {contact.email ? <Text style={styles.subRowMeta}>{contact.email}</Text> : null}
                  </Pressable>
                ))
              )}
            </View>

            <View style={styles.subSection}>
              <View style={styles.subSectionHeader}>
                <Text style={styles.sectionTitle}>Addresses</Text>
                <Pressable onPress={openNewSite}>
                  <Text style={styles.link}>+ Add address</Text>
                </Pressable>
              </View>
              {sites.length === 0 ? (
                <Text style={styles.emptySmall}>No additional addresses on file.</Text>
              ) : (
                sites.map((site) => (
                  <Pressable key={site.id} style={styles.subRow} onPress={() => openEditSite(site)}>
                    <Text style={styles.subRowTitle}>
                      {site.label || "Site"}
                      {site.is_primary ? " (Primary)" : ""}
                    </Text>
                    <Text style={styles.subRowMeta}>{formatClientAddress(site)}</Text>
                  </Pressable>
                ))
              )}
            </View>

            <View style={{ marginHorizontal: 16 }}>
              <MembershipStatusCard clientId={id} />
            </View>

            <Text style={styles.sectionTitle}>Jobs</Text>
          </>
        }
        ListEmptyComponent={<Text style={styles.empty}>No jobs yet for this client.</Text>}
        contentContainerStyle={jobCards.length === 0 ? styles.emptyContainer : undefined}
        ListFooterComponent={
          // Scoped to this client's own jobs (On The Way/review-request
          // messages) - quote/invoice follow-ups aren't included here since
          // there's no locally-synced way to look up "which quotes/invoices
          // belong to this client" offline (quotes/invoices are online-only,
          // see docs/SETUP.md); the job detail screen shows those, since it
          // already fetches its own linked quotes/invoices from Supabase.
          <View style={styles.commLogSection}>
            <Text style={styles.sectionTitle}>Communication Log</Text>
            <CommunicationLog entities={jobCards.map((j) => ({ entityType: "job" as const, entityId: j.id }))} />
          </View>
        }
      />

      <Pressable style={styles.fab} onPress={() => setModalVisible(true)}>
        <Text style={styles.fabText}>+ New job</Text>
      </Pressable>

      <CenteredModal
        visible={modalVisible}
        onClose={() => {
          setModalVisible(false);
          setFormError(null);
        }}
      >
        <Text style={styles.modalTitle}>New job</Text>
        {/* Client details are auto-populated by the job_cards.client_id
            link (this same row shown above) rather than re-entered here -
            there's no separate copy of name/address/email/phone to keep in
            sync, so there's nothing that could drift out of date. */}
        <View style={styles.clientSummary}>
          <Text style={styles.clientSummaryLabel}>Client</Text>
          <Text style={styles.clientSummaryText}>{client.name}</Text>
          {client.phone ? <Text style={styles.clientSummarySub}>{client.phone}</Text> : null}
          {client.email ? <Text style={styles.clientSummarySub}>{client.email}</Text> : null}
          {address ? <Text style={styles.clientSummarySub}>{address}</Text> : null}
        </View>
        <FormField label="Title" placeholder="e.g. Roof inspection" value={title} onChangeText={setTitle} />
        <FormField
          label="Description (optional)"
          placeholder="e.g. valley channel inspection, supply and install"
          value={description}
          onChangeText={setDescription}
          multiline
          style={styles.multiline}
        />
        {formError ? <Text style={styles.error}>{formError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable
            onPress={() => {
              setModalVisible(false);
              setFormError(null);
            }}
          >
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleCreate}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
      </CenteredModal>

      <CenteredModal visible={editModalVisible} onClose={() => setEditModalVisible(false)}>
        <Text style={styles.modalTitle}>Edit client</Text>
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Company client</Text>
          <Switch
            value={editClientType === "company"}
            onValueChange={(v) => setEditClientType(v ? "company" : "individual")}
          />
        </View>
        {editClientType === "company" ? (
          <FormField label="Company name" placeholder="e.g. McGrath Estate Agents" value={editCompanyName} onChangeText={setEditCompanyName} />
        ) : null}
        <FormField
          label={editClientType === "company" ? "Primary contact name" : "Name"}
          placeholder="Client name"
          value={editName}
          onChangeText={setEditName}
        />
        <FormField label="Phone" placeholder="Phone number" value={editPhone} onChangeText={setEditPhone} keyboardType="phone-pad" />
        <FormField
          label="Email"
          placeholder="client@example.com"
          value={editEmail}
          onChangeText={setEditEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
        <FormField label="Address line 1" placeholder="Street address" value={editAddressLine1} onChangeText={setEditAddressLine1} />
        <FormField label="Address line 2 (optional)" placeholder="Unit, floor, etc." value={editAddressLine2} onChangeText={setEditAddressLine2} />
        <View style={styles.addressRow}>
          <View style={styles.addressRowItem}>
            <FormField label="Suburb" placeholder="Suburb" value={editSuburb} onChangeText={setEditSuburb} />
          </View>
          <View style={styles.addressRowItemSmall}>
            <FormField label="State" placeholder="e.g. NSW" value={editState} onChangeText={setEditState} autoCapitalize="characters" />
          </View>
          <View style={styles.addressRowItemSmall}>
            <FormField label="Postcode" placeholder="e.g. 2000" value={editPostcode} onChangeText={setEditPostcode} keyboardType="number-pad" />
          </View>
        </View>
        <FormField
          label="Notes (optional)"
          placeholder="Notes"
          value={editNotes}
          onChangeText={setEditNotes}
          multiline
          style={styles.multiline}
        />
        {editError ? <Text style={styles.error}>{editError}</Text> : null}
        <View style={styles.modalActions}>
          <Pressable onPress={() => setEditModalVisible(false)}>
            <Text style={styles.link}>Cancel</Text>
          </Pressable>
          <Pressable style={styles.button} onPress={handleSaveEdit}>
            <Text style={styles.buttonText}>Save</Text>
          </Pressable>
        </View>
      </CenteredModal>

      <CenteredModal visible={contactModalVisible} onClose={() => setContactModalVisible(false)}>
        <Text style={styles.modalTitle}>{editingContact ? "Edit contact" : "New contact"}</Text>
        <FormField label="Name" placeholder="Contact name" value={contactName} onChangeText={setContactName} />
        <FormField label="Role (optional)" placeholder="e.g. Property Manager" value={contactRole} onChangeText={setContactRole} />
        <FormField label="Phone" placeholder="Phone number" value={contactPhone} onChangeText={setContactPhone} keyboardType="phone-pad" />
        <FormField
          label="Email"
          placeholder="contact@example.com"
          value={contactEmail}
          onChangeText={setContactEmail}
          keyboardType="email-address"
          autoCapitalize="none"
        />
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Primary contact</Text>
          <Switch value={contactIsPrimary} onValueChange={setContactIsPrimary} />
        </View>
        {contactError ? <Text style={styles.error}>{contactError}</Text> : null}
        <View style={styles.modalActionsSplit}>
          {editingContact ? (
            <Pressable onPress={handleDeleteContact}>
              <Text style={styles.deleteLink}>Delete</Text>
            </Pressable>
          ) : (
            <View />
          )}
          <View style={styles.modalActionsRight}>
            <Pressable onPress={() => setContactModalVisible(false)}>
              <Text style={styles.link}>Cancel</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={handleSaveContact}>
              <Text style={styles.buttonText}>Save</Text>
            </Pressable>
          </View>
        </View>
      </CenteredModal>

      <CenteredModal visible={siteModalVisible} onClose={() => setSiteModalVisible(false)}>
        <Text style={styles.modalTitle}>{editingSite ? "Edit address" : "New address"}</Text>
        <FormField label="Label (optional)" placeholder="e.g. Rental property" value={siteLabel} onChangeText={setSiteLabel} />
        <FormField label="Address line 1" placeholder="Street address" value={siteAddressLine1} onChangeText={setSiteAddressLine1} />
        <FormField label="Address line 2 (optional)" placeholder="Unit, floor, etc." value={siteAddressLine2} onChangeText={setSiteAddressLine2} />
        <View style={styles.addressRow}>
          <View style={styles.addressRowItem}>
            <FormField label="Suburb" placeholder="Suburb" value={siteSuburb} onChangeText={setSiteSuburb} />
          </View>
          <View style={styles.addressRowItemSmall}>
            <FormField label="State" placeholder="e.g. NSW" value={siteState} onChangeText={setSiteState} autoCapitalize="characters" />
          </View>
          <View style={styles.addressRowItemSmall}>
            <FormField label="Postcode" placeholder="e.g. 2000" value={sitePostcode} onChangeText={setSitePostcode} keyboardType="number-pad" />
          </View>
        </View>
        <FormField label="Notes (optional)" placeholder="Access notes, etc." value={siteNotes} onChangeText={setSiteNotes} multiline style={styles.multiline} />
        <View style={styles.switchRow}>
          <Text style={styles.switchLabel}>Primary address</Text>
          <Switch value={siteIsPrimary} onValueChange={setSiteIsPrimary} />
        </View>
        {siteError ? <Text style={styles.error}>{siteError}</Text> : null}
        <View style={styles.modalActionsSplit}>
          {editingSite ? (
            <Pressable onPress={handleDeleteSite}>
              <Text style={styles.deleteLink}>Delete</Text>
            </Pressable>
          ) : (
            <View />
          )}
          <View style={styles.modalActionsRight}>
            <Pressable onPress={() => setSiteModalVisible(false)}>
              <Text style={styles.link}>Cancel</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={handleSaveSite}>
              <Text style={styles.buttonText}>Save</Text>
            </Pressable>
          </View>
        </View>
      </CenteredModal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  clientHeader: { padding: 16, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#d1d5db", gap: 4 },
  clientHeaderRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  clientName: { fontSize: 20, fontWeight: "700" },
  clientMeta: { color: "#6b7280" },
  clientNotes: { marginTop: 8, color: "#374151" },
  sectionTitle: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 4, fontWeight: "700", color: "#6b7280" },
  commLogSection: { paddingHorizontal: 16, paddingBottom: 24 },
  row: { paddingHorizontal: 16, paddingVertical: 14, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#d1d5db", flexDirection: "row", alignItems: "center" },
  rowTitleRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  rowNumber: { fontSize: 12, fontWeight: "700", color: "#1d4ed8", flexShrink: 0 },
  rowTitle: { fontSize: 16, fontWeight: "600", flex: 1 },
  // flexShrink so a long lifecycle stage name (free text, admin-defined,
  // no length cap) can't overflow past the row's edge next to the
  // flex:1 title block - same fix shape as jobs/index.tsx's stageBadgeText.
  rowSubtitle: { color: "#6b7280", marginTop: 2, flexShrink: 1, maxWidth: "40%", textAlign: "right" },
  empty: { textAlign: "center", color: "#6b7280" },
  emptyContainer: { flex: 1, justifyContent: "center", padding: 24 },
  link: { color: "#1d4ed8", fontWeight: "600" },
  fab: {
    position: "absolute",
    right: 16,
    bottom: 24,
    backgroundColor: "#1d4ed8",
    borderRadius: 24,
    paddingHorizontal: 20,
    paddingVertical: 14,
  },
  fabText: { color: "#fff", fontWeight: "700" },
  modalTitle: { fontSize: 18, fontWeight: "700", marginBottom: 4 },
  clientSummary: { backgroundColor: "#f3f4f6", borderRadius: 8, padding: 12, gap: 2 },
  clientSummaryLabel: { fontSize: 12, fontWeight: "700", color: "#6b7280", marginBottom: 2 },
  clientSummaryText: { fontSize: 15, fontWeight: "600", color: "#111827" },
  clientSummarySub: { fontSize: 13, color: "#6b7280" },
  addressRow: { flexDirection: "row", gap: 8 },
  addressRowItem: { flex: 2 },
  addressRowItemSmall: { flex: 1 },
  multiline: { minHeight: 80, textAlignVertical: "top" },
  modalActions: { flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: 20, marginTop: 8 },
  modalActionsSplit: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 8 },
  modalActionsRight: { flexDirection: "row", alignItems: "center", gap: 20 },
  deleteLink: { color: "#dc2626", fontWeight: "600" },
  button: { backgroundColor: "#1d4ed8", borderRadius: 8, paddingHorizontal: 20, paddingVertical: 10 },
  buttonText: { color: "#fff", fontWeight: "600" },
  error: { color: "#dc2626" },
  switchRow: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4, marginBottom: 8, gap: 12 },
  switchLabel: { fontSize: 14, fontWeight: "600", color: "#374151", flex: 1 },
  subSection: { paddingHorizontal: 16 },
  subSectionHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginTop: 4 },
  subRow: { paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#d1d5db" },
  subRowTitle: { fontSize: 14, fontWeight: "600", color: "#111827" },
  subRowMeta: { fontSize: 13, color: "#6b7280", marginTop: 1 },
  emptySmall: { color: "#9ca3af", fontSize: 13, paddingVertical: 8 },
});
