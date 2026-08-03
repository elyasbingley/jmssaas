import { Navigate, Route, Routes } from "react-router-dom";
import { RequireAdmin } from "./components/RequireAdmin";
import { Layout } from "./components/Layout";
import LoginPage from "./pages/Login";
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
                <Route path="/jobs" element={<StubPage title="Jobs" />} />
                <Route path="/quotes" element={<StubPage title="Quotes" />} />
                <Route path="/invoices" element={<StubPage title="Invoices" />} />
                <Route path="/clients" element={<StubPage title="Clients" />} />
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
