import { type FormEvent, useEffect, useState } from "react";
import { getHealth, type Health, type Settings, type ShippingAddress } from "../lib/Api";
import styles from "./SettingsScreen.module.css";

interface SettingsScreenProps {
  settings: Settings | null;
  onSaveAddress: (address: ShippingAddress) => Promise<void>;
}

const EMPTY_ADDRESS: ShippingAddress = {
  recipientName: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  stateOrProvince: "",
  postalCode: "",
  country: "Singapore",
  phone: "",
};

const ADDRESS_KEYS = Object.keys(EMPTY_ADDRESS) as (keyof ShippingAddress)[];

export function SettingsScreen({ settings, onSaveAddress }: SettingsScreenProps) {
  const persistedAddress = settings?.shippingAddress ?? EMPTY_ADDRESS;
  const [address, setAddress] = useState<ShippingAddress>({ ...persistedAddress });
  const [saving, setSaving] = useState(false);

  useEffect(() => setAddress({ ...(settings?.shippingAddress ?? EMPTY_ADDRESS) }), [settings]);

  /*
   * Which rail this backend is on, read from it rather than guessed. The chain id is what decides
   * whether a purchase spends real XSGD, and a demo that cannot tell testnet from mainnet at a
   * glance is one misconfigured variable away from spending real money by accident.
   */
  const [health, setHealth] = useState<Health | null>(null);
  useEffect(() => {
    let cancelled = false;
    void getHealth()
      .then((next) => !cancelled && setHealth(next))
      .catch(() => !cancelled && setHealth(null));
    return () => {
      cancelled = true;
    };
  }, []);

  if (!settings) return <div className={styles.screen} />;

  const isDirty = ADDRESS_KEYS.some((key) => address[key] !== persistedAddress[key]);
  const isSaved = settings.shippingAddress !== null && !isDirty;

  const setField = (key: keyof ShippingAddress, value: string) => {
    setAddress((current) => ({ ...current, [key]: value }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onSaveAddress(address);
    } finally {
      setSaving(false);
    }
  };

  const values = [
    {
      name: "Region & currency",
      desc: "Used for listings, taxes and shipping estimates.",
      value: settings.region,
    },
    {
      name: "Data retention",
      desc: "How long agent transcripts and screenshots are kept.",
      value: settings.dataRetention,
    },
  ];

  return (
    <div className={styles.screen}>
      <div className={styles.column}>
        <h2 className={styles.h2}>Settings</h2>

        {health && (
          <div
            className={`${styles.network} ${health.network.realMoney ? styles.networkLive : styles.networkTest}`}
          >
            <div className={styles.networkHead}>
              <span className={styles.networkBadge}>
                {health.network.realMoney ? "MAINNET · REAL MONEY" : "TESTNET"}
              </span>
              <span className={styles.networkName}>{health.network.name}</span>
            </div>
            <dl className={styles.networkGrid}>
              <div>
                <dt>Chain</dt>
                <dd>{health.network.chainId}</dd>
              </div>
              <div>
                <dt>Card issuer</dt>
                <dd>
                  {health.network.issuer} · {health.network.cardApi}
                </dd>
              </div>
              <div>
                <dt>Closer</dt>
                <dd>{health.purchaseAgentProvider}</dd>
              </div>
              <div>
                <dt>Wallet</dt>
                <dd className={styles.networkMono}>
                  {health.network.walletAddress
                    ? `${health.network.walletAddress.slice(0, 6)}…${health.network.walletAddress.slice(-4)}`
                    : "not configured"}
                </dd>
              </div>
            </dl>
            <p className={styles.networkNote}>
              {health.network.realMoney
                ? "Purchases here spend real XSGD on Avalanche and mint real cards. There are no refunds on this rail."
                : "Purchases here settle on a test network. No real money moves."}
            </p>
          </div>
        )}
        <div className={styles.panel}>
          {values.map((row) => (
            <div className={styles.row} key={row.name}>
              <div className={styles.rowBody}>
                <div className={styles.name}>{row.name}</div>
                <div className={styles.desc}>{row.desc}</div>
              </div>
              <span className={styles.value}>{row.value}</span>
            </div>
          ))}
        </div>

        <div className={styles.sectionHeading}>
          <div>
            <h3>Delivery address</h3>
            <p>Where Happy should ask the Closer agent to ship your purchases.</p>
          </div>
          {isSaved && <span className={styles.saved}>Saved</span>}
        </div>

        <form className={styles.addressPanel} onSubmit={(event) => void submit(event)}>
          <div className={styles.fieldGrid}>
            <label className={styles.fullField}>
              <span>Recipient name</span>
              <input
                value={address.recipientName}
                onChange={(event) => setField("recipientName", event.target.value)}
                autoComplete="name"
                maxLength={120}
                required
              />
            </label>

            <label className={styles.fullField}>
              <span>Address line 1</span>
              <input
                value={address.addressLine1}
                onChange={(event) => setField("addressLine1", event.target.value)}
                autoComplete="address-line1"
                maxLength={200}
                placeholder="Street address and unit number"
                required
              />
            </label>

            <label className={styles.fullField}>
              <span>
                Address line 2 <small>Optional</small>
              </span>
              <input
                value={address.addressLine2}
                onChange={(event) => setField("addressLine2", event.target.value)}
                autoComplete="address-line2"
                maxLength={200}
                placeholder="Building, floor, or delivery note"
              />
            </label>

            <label>
              <span>City</span>
              <input
                value={address.city}
                onChange={(event) => setField("city", event.target.value)}
                autoComplete="address-level2"
                maxLength={100}
                required
              />
            </label>

            <label>
              <span>
                State / province <small>Optional</small>
              </span>
              <input
                value={address.stateOrProvince}
                onChange={(event) => setField("stateOrProvince", event.target.value)}
                autoComplete="address-level1"
                maxLength={100}
              />
            </label>

            <label>
              <span>Postal code</span>
              <input
                value={address.postalCode}
                onChange={(event) => setField("postalCode", event.target.value)}
                autoComplete="postal-code"
                maxLength={20}
                required
              />
            </label>

            <label>
              <span>Country</span>
              <input
                value={address.country}
                onChange={(event) => setField("country", event.target.value)}
                autoComplete="country-name"
                maxLength={80}
                required
              />
            </label>

            <label className={styles.fullField}>
              <span>
                Phone number <small>Optional</small>
              </span>
              <input
                type="tel"
                value={address.phone}
                onChange={(event) => setField("phone", event.target.value)}
                autoComplete="tel"
                maxLength={40}
                placeholder="For merchant delivery updates"
              />
            </label>
          </div>

          <div className={styles.formActions}>
            <p>Shared with the purchase agent only when it is time to check out.</p>
            <button type="submit" disabled={saving || !isDirty}>
              {saving ? "Saving…" : "Save address"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
