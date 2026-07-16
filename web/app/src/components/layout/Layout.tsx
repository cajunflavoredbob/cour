import type { ReactNode } from "react";
import { Wordmark } from "../atoms/Wordmark";
import styles from "./Layout.module.css";

interface LayoutProps {
  children: ReactNode;
  hideLogo?: boolean;
  className?: string;
}

export const Layout = ({ children, className, hideLogo = false }: LayoutProps) => (
  <section className={`${styles.screenLayout} ${className ?? ""}`}>
    {!hideLogo && <Wordmark />}
    {children}
  </section>
);
