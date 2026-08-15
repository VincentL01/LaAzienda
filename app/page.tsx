import { CompanyDashboard } from "./components/CompanyDashboard";
import { ProductHeader } from "./components/ProductHeader";

export default function Home() {
  return <><ProductHeader active="office" /><CompanyDashboard /></>;
}
