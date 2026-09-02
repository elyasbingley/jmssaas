import { Navigate, Route, Routes } from "react-router-dom";
import { RequireAdmin } from "./components/RequireAdmin";
import { Layout } from "./components/Layout";
import LoginPage from "./pages/Login";
import ClientsPage from "./pages/Clients";
import ClientDetailPage from "./pages/ClientDetail";
import JobsPage from "./pages/Jobs";
import JobDetailPage from "./pages/JobDetail";
import QuotesPage from "./pages/Quotes";
import QuoteNewPage from "./pages/QuoteNew";
import QuoteDetailPage from "./pages/QuoteDetail";
import InvoicesPage from "./pages/Invoices";
import InvoiceNewPage from "./pages/InvoiceNew";
import InvoiceDetailPage from "./pages/InvoiceDetail";
import PriceBookPage from "./pages/PriceBook";
import PriceBookCategoryPage from "./pages/PriceBookCategory";
import PriceBookItemPage from "./pages/PriceBookItem";
import CalendarPage from "./pages/Calendar";
import SettingsPage from "./pages/Settings";
import AutomationSettingsPage from "./pages/AutomationSettings";
import JobSetupPage from "./pages/JobSetup";
import JobTemplatesPage from "./pages/JobTemplates";
import BundlesPage from "./pages/Bundles";
import BundleDetailPage from "./pages/BundleDetail";
import InventoryPage from "./pages/Inventory";
import InventorySetupPage from "./pages/InventorySetup";
import DispatchPage from "./pages/Dispatch";
import TeamPage from "./pages/Team";
import JobCostingPage from "./pages/JobCosting";
import AnalyticsPage from "./pages/Analytics";
import TasksPage from "./pages/Tasks";
import TaskDetailPage from "./pages/TaskDetail";
import RealEstatePage from "./pages/RealEstate";
import PropertyDetailPage from "./pages/PropertyDetail";
import MembershipPage from "./pages/Membership";
import GoogleReviewsPage from "./pages/GoogleReviews";
import B2BReferralsPage from "./pages/B2BReferrals";
import ReportsPage from "./pages/Reports";
import ReportTemplateEditorPage from "./pages/ReportTemplateEditor";
import ReportInstancePage from "./pages/ReportInstance";
import SubcontractorsPage from "./pages/Subcontractors";
import SubcontractorDetailPage from "./pages/SubcontractorDetail";
import PurchaseOrderNewPage from "./pages/PurchaseOrderNew";
import PurchaseOrderDetailPage from "./pages/PurchaseOrderDetail";
import CostOfOpsLayout from "./pages/cost-of-ops/CostOfOpsLayout";
import OperatingExpensesPage from "./pages/cost-of-ops/OperatingExpenses";
import LabourPage from "./pages/cost-of-ops/Labour";
import CostOfOperationsPage from "./pages/cost-of-ops/CostOfOperations";
import ProfitabilityPage from "./pages/cost-of-ops/Profitability";
import QuoteCheckerPage from "./pages/cost-of-ops/QuoteChecker";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/*"
        element={
          <RequireAdmin>
            <Layout>
              <Routes>
                <Route path="/" element={<Navigate to="/dispatch" replace />} />
                <Route path="/dispatch" element={<DispatchPage />} />
                <Route path="/tasks" element={<TasksPage />}>
                  <Route path=":id" element={<TaskDetailPage />} />
                </Route>
                <Route path="/jobs" element={<JobsPage />} />
                <Route path="/jobs/:id" element={<JobDetailPage />} />
                <Route path="/quotes" element={<QuotesPage />} />
                <Route path="/quotes/new" element={<QuoteNewPage />} />
                <Route path="/quotes/:id" element={<QuoteDetailPage />} />
                <Route path="/invoices" element={<InvoicesPage />} />
                <Route path="/invoices/new" element={<InvoiceNewPage />} />
                <Route path="/invoices/:id" element={<InvoiceDetailPage />} />
                <Route path="/clients" element={<ClientsPage />} />
                <Route path="/clients/:id" element={<ClientDetailPage />} />
                <Route path="/price-book" element={<PriceBookPage />} />
                <Route path="/price-book/categories/:id" element={<PriceBookCategoryPage />} />
                <Route path="/price-book/items/:id" element={<PriceBookItemPage />} />
                <Route path="/job-costing" element={<JobCostingPage />} />
                <Route path="/analytics" element={<AnalyticsPage />} />
                <Route path="/inventory" element={<InventoryPage />} />
                <Route path="/calendar" element={<CalendarPage />} />
                <Route path="/team" element={<TeamPage />} />
                <Route path="/real-estate" element={<RealEstatePage />} />
                <Route path="/real-estate/properties/:id" element={<PropertyDetailPage />} />
                <Route path="/membership" element={<MembershipPage />} />
                <Route path="/google-reviews" element={<GoogleReviewsPage />} />
                <Route path="/b2b-referrals" element={<B2BReferralsPage />} />
                <Route path="/reports" element={<ReportsPage />} />
                <Route path="/reports/templates/new" element={<ReportTemplateEditorPage />} />
                <Route path="/reports/templates/:id" element={<ReportTemplateEditorPage />} />
                <Route path="/reports/instances/:id" element={<ReportInstancePage />} />
                <Route path="/subcontractors" element={<SubcontractorsPage />} />
                <Route path="/subcontractors/purchase-orders/new" element={<PurchaseOrderNewPage />} />
                <Route path="/subcontractors/purchase-orders/:id" element={<PurchaseOrderDetailPage />} />
                <Route path="/subcontractors/:id" element={<SubcontractorDetailPage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/automation" element={<AutomationSettingsPage />} />
                <Route path="/settings/job-setup" element={<JobSetupPage />} />
                <Route path="/settings/job-templates" element={<JobTemplatesPage />} />
                <Route path="/settings/bundles" element={<BundlesPage />} />
                <Route path="/settings/bundles/:id" element={<BundleDetailPage />} />
                <Route path="/settings/inventory-setup" element={<InventorySetupPage />} />
                <Route path="/settings/cost-of-ops" element={<CostOfOpsLayout />}>
                  <Route index element={<Navigate to="operating-expenses" replace />} />
                  <Route path="operating-expenses" element={<OperatingExpensesPage />} />
                  <Route path="labour" element={<LabourPage />} />
                  <Route path="cost-of-operations" element={<CostOfOperationsPage />} />
                  <Route path="profitability" element={<ProfitabilityPage />} />
                  <Route path="quote-checker" element={<QuoteCheckerPage />} />
                </Route>
                <Route path="*" element={<Navigate to="/dispatch" replace />} />
              </Routes>
            </Layout>
          </RequireAdmin>
        }
      />
    </Routes>
  );
}
