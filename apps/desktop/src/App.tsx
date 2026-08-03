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
import { StubPage } from "./pages/Stub";

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
                <Route path="/dispatch" element={<StubPage title="Dispatch" />} />
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
                <Route path="/price-book" element={<StubPage title="Price Book" />} />
                <Route path="/calendar" element={<StubPage title="Calendar" />} />
                <Route path="/team" element={<StubPage title="Team" />} />
                <Route path="/settings" element={<StubPage title="Settings" />} />
                <Route path="*" element={<Navigate to="/dispatch" replace />} />
              </Routes>
            </Layout>
          </RequireAdmin>
        }
      />
    </Routes>
  );
}
