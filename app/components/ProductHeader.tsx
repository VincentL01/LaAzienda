import Link from "next/link";

export function ProductHeader({ active }: { active: "office" | "company" | "employees" | "training" | "animations" }) {
  return (
    <header className="product-header">
      <Link href="/" className="brand" aria-label="One Man Company home">
        <span className="brand-mark" aria-hidden="true"><i /><i /><i /><i /></span>
        <span><b>ONE MAN</b><small>COMPANY</small></span>
      </Link>
      <nav aria-label="Primary navigation">
        <Link className={active === "office" ? "active" : ""} href="/">Office</Link>
        <Link className={active === "company" ? "active" : ""} href="/company">Company</Link>
        <Link className={active === "employees" ? "active" : ""} href="/employees">Employees</Link>
        <Link className={active === "training" ? "active" : ""} href="/training">Training</Link>
        <Link className={active === "animations" ? "active" : ""} href="/animations">Animations</Link>
      </nav>
      <div className="system-pill"><span /> Local company</div>
    </header>
  );
}
