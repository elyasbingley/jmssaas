import { Navigate, Route, Routes } from "react-router-dom";
import { RequireAdmin } from "./components/RequireAdmin";
import { Layout } from "./components/Layout";
import LoginPage from "./pages/Login";
import ClientsPage from "./pages/Clients";
import ClientDetailPage from "./pages/ClientDetail";
import JobsPage from "./pages/Jobs";
import JobDetailPage from "./pages/JobDetail";
import JobMeasurePage from "./pages/JobMeasure";
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
import CalendarEventNewPage from "./pages/CalendarEventNew";
import CalendarEventDetailPage from "./pages/CalendarEventDetail";
import SettingsPage from "./pages/Settings";
import AutomationSettingsPage from "./pages/AutomationSettings";
import JobSetupPage from "./pages/JobSetup";
import InventoryPage from "./pages/Inventory";
import InventorySetupPage from "./pages/InventorySetup";
import DispatchPage from "./pages/Dispatch";
import TeamPage from "./pages/Team";
import JobCostingPage from "./pages/JobCosting";
import TasksPage from "./pages/Tasks";
import TaskDetailPage from "./pages/TaskDetail";
import RealEstatePage from "./pages/RealEstate";
import PropertyDetailPage from "./pages/PropertyDetail";
import B2BReferralsPage from "./pages/B2BReferrals";
import ReportsPage from "./pages/Reports";
import ReportTemplateEditorPage from "./pages/ReportTemplateEditor";
import ReportInstancePage from "./pages/ReportInstance";

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
                <Route path="/tasks" element={<TasksPage />} />
                <Route path="/tasks/:id" element={<TaskDetailPage />} />
                <Route path="/jobs" element={<JobsPage />} />
                <Route path="/jobs/:id" element={<JobDetailPage />} />
                <Route path="/jobs/:id/measure" element={<JobMeasurePage />} />
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
                <Route path="/inventory" element={<InventoryPage />} />
                <Route path="/calendar" element={<CalendarPage />} />
                <Route path="/calendar/new" element={<CalendarEventNewPage />} />
                <Route path="/calendar/:id" element={<CalendarEventDetailPage />} />
                <Route path="/team" element={<TeamPage />} />
                <Route path="/real-estate" element={<RealEstatePage />} />
                <Route path="/real-estate/properties/:id" element={<PropertyDetailPage />} />
                <Route path="/b2b-referrals" element={<B2BReferralsPage />} />
                <Route path="/reports" element={<ReportsPage />} />
                <Route path="/reports/templates/new" element={<ReportTemplateEditorPage />} />
                <Route path="/reports/templates/:id" element={<ReportTemplateEditorPage />} />
                <Route path="/reports/instances/:id" element={<ReportInstancePage />} />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="/settings/automation" element={<AutomationSettingsPage />} />
                <Route path="/settings/job-setup" element={<JobSetupPage />} />
                <Route path="/settings/inventory-setup" element={<InventorySetupPage />} />
                <Route path="*" element={<Navigate to="/dispatch" replace />} />
              </Routes>
            </Layout>
          </RequireAdmin>
        }
      />
    </Routes>
  );
}
