import { Layout } from "../layout/Layout";
import styles from "./Config.module.css";

// Shown when the server boots with an empty `servers` config block.
// Deliberately has no inputs -- configuration lives in env vars /
// config.yaml only, so there is no way (and no need) to submit it from
// the browser. The container log carries the actionable detail for
// whoever runs the server.
export const ConfigScreen = () => (
  <Layout>
    <div className={styles.notice}>
      <h1 className={styles.heading}>cour isn't set up yet</h1>
      <p className={styles.body}>
        This cour server hasn't been configured. Check back once it's ready.
      </p>
    </div>
  </Layout>
);
