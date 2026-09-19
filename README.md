# Kusum Jewelers ERP

Lightweight local ERP for jewellery inventory, daily gold and silver rates, barcode billing, customer credit, cashbook, URD purchases, exports and archive management.

## Shop PC portable package

Use the generated `Kusum ERP-win32-x64` folder on the shop PC. Copy the entire folder and run `Kusum ERP.exe`; do not copy only the EXE. On first start, the ERP opens its one-time setup page. It uses the local MySQL administrator password only for setup, creates or upgrades the selected ERP database, applies the bundled schema migrations, and creates the limited shared ERP database account. The MySQL administrator password is never saved.

Before first use, install and start **MySQL Server** on the main database PC. For barcode labels, install the Windows driver for the **TSC TTP-244 Pro** and select its exact Windows printer name in the ERP. To update an installation, close the ERP and replace the entire old application folder; do not delete the MySQL database or `%LOCALAPPDATA%\Kusum Jewelers ERP` configuration folder.

## Linux desktop package

The first Linux target is Ubuntu/Debian 64-bit. On a Linux build host, run `npm install`, `npm run db:generate`, then `npm run package:linux`. The command creates a fresh `Kusum ERP-linux-x64` folder under `output/`. Copy the entire folder and run `./Kusum ERP`; Node.js is not required on the shop PC.

Install MySQL Server on the main database PC and CUPS for USB or shared printers. In ERP printer setup, choose **CUPS printer / USB** and enter the exact CUPS queue name, or choose **Direct TCP / Ethernet** for a network TSPL printer. The Linux package uses the same database, migrations, PDFs, Excel exports, barcodes and LAN setup as the Windows package.

To create a Debian/Ubuntu installer, run `npm run package:linux:deb`. It creates a fresh `kusum-erp_<version>_amd64.deb` installer under `output/`. Install it on Ubuntu/Debian with `sudo apt install ./kusum-erp_<version>_amd64.deb`; the application is installed under `/opt/kusum-erp` and a desktop-menu shortcut is added.

## Local setup

1. Create a MySQL database named `kusum_erp`.
2. Copy `.env.example` to `.env` and enter the local database and login settings.
3. Install packages with `npm install`.
4. Run `npm run db:generate`, then `npm run db:migrate`.
5. Start the app with `npm start` and open `http://localhost:3000`.

## Shared main PC / client PC setup

There is one database, normally named `kusum_erp`, on the main database PC. It contains all sales, stock, customers, cashbook records and settings. Every client PC connects to that same database; a client PC does **not** create or copy a second database.

1. On the main PC, install MySQL Server and run the ERP. Choose **Main database PC**, use `localhost`, and record the database name, port, shared ERP database username and password that you choose.
2. In ERP on the main PC open **Network PCs**. Use a shown LAN IP address; allow that MySQL port through Windows Firewall only for the Private shop network / local subnet. Do not expose MySQL to the internet.
3. On every client PC, run ERP and choose **Client PC**. Enter the main PC's LAN IP, the same MySQL port, same database name, and the same shared ERP database username and password. Do not use `localhost` on a client PC.
4. The ERP login (`kusum` by default) is separate from the MySQL shared ERP database username. The MySQL root account is only for main-PC setup and is not entered on client PCs.

If the saved details are stale—for example MySQL was reinstalled on a new port—the ERP opens **Repair ERP connection**. Save the current settings there; it changes only that PC's local connection settings and never deletes the shared database.

## TSC TTP-244 Pro barcode labels

Barcode labels are sent as native TSPL raw data - never as PDF labels. The ERP uses the included `GOLD.PRN` and `SILVER.PRN` templates verbatim.

In **Barcode printer** choose the transport for each PC:

- **Windows printer / USB** (recommended): sends a RAW TSPL job through the Windows spooler. It works with a USB TSC, a Windows shared printer, or a printer installed with a Windows Standard TCP/IP port.
- **Direct TCP / Ethernet**: opens a TCP connection to the configured printer or print-server IP and sends the same TSPL bytes. Use this only if that actual printer/interface has a reachable IP address. A router provides the LAN path; it cannot give Ethernet capability to a USB-only printer.

The equivalent environment settings are:

```env
TSC_PRINTER_MODE=WINDOWS
TSC_PRINTER_NAME=TSC TTP-244 Pro
TSC_PRINTER_HOST=
TSC_PRINTER_PORT=9100
```

Use **Recheck printer** to test the Windows queue or TCP connection, then **Test TSC** to send a real test label. A successful Windows result proves the spooler accepted the RAW bytes; a successful TCP result proves the network endpoint accepted the bytes. Confirm the final physical label at the printer.

## Security

Do not commit `.env`, database backups, exports, or temporary work files. Configure credentials locally through environment variables.

## Sales invoice PDF WhatsApp automation

The ERP supports only one WhatsApp automation: sending a completed sales invoice PDF. It does not automate reports, purchases, schemes, reminders or marketing messages.

Configure an official WhatsApp Business Cloud API number and an approved utility template with a document header. Add the credentials locally to `.env` (never to source control):

```env
WHATSAPP_ENABLED=true
WHATSAPP_ACCESS_TOKEN=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_TEMPLATE_NAME=invoice_ready
WHATSAPP_TEMPLATE_LANGUAGE=en
WHATSAPP_GRAPH_API_VERSION=v23.0
WHATSAPP_WEBHOOK_VERIFY_TOKEN=...
WHATSAPP_APP_SECRET=...
```

The template body must accept three text values: customer name, invoice number and total amount. The customer must have a valid mobile number and explicit WhatsApp opt-in. Enable **Automatically send the sales PDF after a sale is saved** in Business settings. The ERP queues the PDF after the sale transaction commits, sends it through the API worker, and records only the delivery status and provider error metadata. If the provider reports a billing problem, the message is paused without blocking the sale; the PDF remains available for manual download. The webhook URL is `/webhooks/whatsapp` and must be reachable over HTTPS from Meta.
