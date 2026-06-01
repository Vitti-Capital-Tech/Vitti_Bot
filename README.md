

# VITTI Bot: Options Terminal

VITTI Bot is a professional, automated multi-account options execution engine and real-time dashboard designed for executing, monitoring, and managing strangle options strategies on Delta Exchange India. 

The software operates as a background execution engine that places trades and handles risk management automatically, while the web dashboard serves as a premium control room to monitor real-time yield performance, link trading accounts, and configure strategy parameters.

---

## 1. System Documentation Index

The following table provides links to the architectural plans, detailed execution diagrams, and proprietary terms for this project:

| Document Name | Focus Area | Access Link |
| :--- | :--- | :--- |
| **High-Level Design (HLD)** | System architecture flowcharts, user control layers, data sync pipelines, and daily lifecycles. | [View HLD](docs/HLD.md) |
| **Low-Level Design (LLD)** | Database tables schema, cryptographic API signatures (HMAC-SHA256), state machines, and error safeguards. | [View LLD](docs/LLD.md) |
| **Proprietary Software License** | Proprietary usage rights and copyright conditions for Vitti Capital desk operations. | [View License](LICENSE) |

---

## 2. Core Concepts for Non-Technical Users

### What is an Option Strangle?
An Option Strangle is a market-neutral strategy used when you expect an asset's price (such as Bitcoin) to remain relatively stable and stay within a defined price range for the day.

To execute a strangle, VITTI Bot simultaneously sells two Out-Of-The-Money (OTM) contracts:
1. **Short Call Option**: A contract that remains profitable as long as the asset price does not surge past a high price ceiling.
2. **Short Put Option**: A contract that remains profitable as long as the asset price does not fall past a low price floor.

By selling both options, the bot collects cash up front (known as **premium**). As long as the asset price remains between the floor and the ceiling, the options naturally lose value (called **time decay**) throughout the day. The bot buys them back at a cheaper price to lock in the difference as profit.

---

## 3. How the Automation Logic Works

VITTI Bot runs continuously in the background and executes the strategy based on your customized parameters:

1. **Scheduled Entry**: At your exact configured entry time (e.g. 09:48 IST), the bot evaluates the underlying asset spot price, fetches the active options chain, selects option contracts based on your target Strike Selection setting (OTM1 to OTM6), and submits unbracketed short strangle orders to Delta Exchange.
2. **High-Frequency Monitoring (Every 10 Seconds)**: Once trades are filled, the background monitoring threads check live Bid/Ask books every 10 seconds:
    * **Stop Loss (Local)**: If the contract's active Ask premium inflates past your configured Stop Loss target (indicating an adverse market move), the bot bypasses exchange delays and executes a local market buy order to close the leg and limit loss.
    * **Take Profit (Local - Decay 2)**: If the contract's Ask premium decays down to or below your configured Take Profit target, the bot closes the position to secure your profit.
    * **Spot Target (Local - Decay 1)**: If the underlying asset spot price moves past your configured target percentage, the bot closes the position immediately.
    * **Joint Exit Protection (Decay 2)**: If either leg triggers an exit, the bot immediately squares off the remaining leg to eliminate portfolio risk.
3. **Scheduled Time Exit**: At your exact configured exit time, the bot automatically exits any remaining open contracts at market price to prevent overnight gap risks.

---

## 4. Control Panel Operations

The web dashboard is organized into clear workspaces:

* **Live Positions Terminal**: Displays current open strangle pairs, live Entry/Mark values, floating P&L updated every 10 seconds, and a single-click "Square Off Strangle" emergency override.
* **Trading Accounts Terminal**: Allows you to easily link, enable, disable, or delete exchange API credentials. It supports both Testnet (demo sandbox) and Production (real money) environments.
* **Configure Strategies Workspace**: Lets you adjust Entry/Exit times, Stop Loss multipliers, strike criteria (OTM1 to OTM6), and favorable spot targets dynamically without touching any code.
* **Live Database Console**: A collapsible panel located at the bottom of the page. It can be opened to review chronological transaction events, execution events, and database status updates.
