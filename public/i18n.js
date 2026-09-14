/* Kusum ERP interface language switch.
   Only visible UI text, labels, placeholders and accessible hints are
   translated.  Database values, form values, barcodes, invoices, Excel,
   PDFs and printer commands are never touched. */
'use strict';

(function initUiLanguage() {
  const STORAGE_KEY = 'kusum-erp-ui-language';
  const MARATHI = {
    'Workspace': 'कार्यक्षेत्र',
    'Manage': 'व्यवस्थापन',
    'Overview': 'आढावा',
    'Skip to content': 'मुख्य भागावर जा',
    'Search anything…': 'शोधा…',
    '+ Batch Add Pieces': '+ बॅचने वस्तू जोडा',
    'Your stock, sales and accounts. In one place.': 'तुमचा साठा, विक्री आणि हिशेब. एकाच ठिकाणी.',
    'Stock & performance': 'साठा आणि कामगिरी',
    'Sales & accounts': 'विक्री आणि हिशेब',
    'Recent invoices': 'अलीकडील बिले',
    'View all': 'सर्व पहा',
    'Gold stock': 'सोन्याचा साठा',
    'Silver stock': 'चांदीचा साठा',
    'Sales today': 'आजची विक्री',
    'Cash flow today': 'आजचा रोख प्रवाह',
    'Customer receivables': 'ग्राहकांकडून येणे',
    'Open balance register': 'बाकी रजिस्टर उघडा',
    'Hide navigation': 'नेव्हिगेशन लपवा',
    'Show navigation': 'नेव्हिगेशन दाखवा',
    'Stock by metal': 'धातूनुसार साठा',
    'Top selling item today': 'आज सर्वाधिक विकलेली वस्तू',
    'Item-wise stock': 'वस्तूनुसार साठा',
    'No sales today': 'आज विक्री नाही',
    'View sales register': 'विक्री रजिस्टर पहा',
    'No stock available': 'साठा उपलब्ध नाही',
    'Category': 'वर्ग',
    'Net weight': 'निव्वळ वजन',
    'Dashboard': 'डॅशबोर्ड',
    'Inventory': 'साठा',
    'Item Names': 'वस्तू नावे',
    'Daily rates': 'दैनिक दर',
    'Daily metal rates': 'दैनिक धातू दर',
    'Sales': 'विक्री',
    'URD Purchase': 'जुने सोने/चांदी खरेदी',
    'URD Purchases': 'जुने सोने/चांदी खरेदी',
    'Cashbook': 'रोखवही',
    'Customers': 'ग्राहक',
    'Schemes': 'बचत योजना',
    'Reports': 'अहवाल',
    'Export & archive': 'निर्यात व संग्रह',
    'Network PCs': 'नेटवर्क संगणक',
    'Jewelry management': 'ज्वेलरी व्यवस्थापन',
    'Signed in as': 'साइन इन केलेले:',
    'Change password': 'पासवर्ड बदला',
    'Sign out': 'बाहेर पडा',
    'More': 'अधिक',
    'Search': 'शोधा',
    'Clear': 'साफ करा',
    'Reset': 'रीसेट',
    'Filter': 'फिल्टर',
    'Apply filters': 'फिल्टर लागू करा',
    'Export Excel': 'Excel निर्यात',
    'Export / archive': 'निर्यात / संग्रह',
    'Export': 'निर्यात',
    'Cancel': 'रद्द करा',
    'Save': 'जतन करा',
    'Save changes': 'बदल जतन करा',
    'Save Changes': 'बदल जतन करा',
    'Save entry': 'नोंद जतन करा',
    'Save Customer': 'ग्राहक जतन करा',
    'Save daily rates': 'दैनिक दर जतन करा',
    'Save URD purchase': 'URD खरेदी जतन करा',
    'New sale': 'नवीन विक्री',
    '+ New sale': '+ नवीन विक्री',
    '+ Create invoice': '+ बिल तयार करा',
    'Create invoice': 'बिल तयार करा',
    '+ Add Customer': '+ ग्राहक जोडा',
    'Add Customer': 'ग्राहक जोडा',
    '+ Add entry': '+ नोंद जोडा',
    'Add entry': 'नोंद जोडा',
    '+ New purchase': '+ नवीन खरेदी',
    'New URD purchase': 'नवीन URD खरेदी',
    '+ Add single item': '+ एक वस्तू जोडा',
    'Add jewellery item': 'दागिन्याची वस्तू जोडा',
    'Edit jewellery item': 'दागिन्याची वस्तू बदला',
    'Batch Add Pieces': 'बॅचने वस्तू जोडा',
    '+ Batch Stock': '+ बॅच साठा',
    '+ Cash Entry': '+ रोख नोंद',
    'Printer setup': 'प्रिंटर सेटअप',
    'Test TSC printer': 'TSC प्रिंटर तपासा',
    'Stock control': 'साठा नियंत्रण',
    'Billing desk': 'बिलिंग काउंटर',
    'Daily money log': 'दैनिक पैशांची नोंद',
    'Contacts': 'संपर्क',
    'Pricing control': 'दर नियंत्रण',
    'Old gold / silver buying': 'जुने सोने / चांदी खरेदी',
    'Customer book': 'ग्राहक यादी',
    'Invoices': 'बिले',
    'Date': 'दिनांक',
    'From': 'पासून',
    'To': 'पर्यंत',
    'Method': 'पेमेंट प्रकार',
    'Type': 'प्रकार',
    'Description': 'तपशील',
    'Customer': 'ग्राहक',
    'Customer mobile / ID': 'ग्राहक मोबाईल / ID',
    'Customer search': 'ग्राहक शोधा',
    'Full name *': 'पूर्ण नाव *',
    'Mobile number': 'मोबाईल क्रमांक',
    'Email': 'ईमेल',
    'Address': 'पत्ता',
    'PAN number': 'PAN क्रमांक',
    'Item name': 'वस्तूचे नाव',
    'Category': 'वर्ग',
    'Barcode': 'बारकोड',
    'Weight (g)': 'वजन (ग्रॅम)',
    'Metal': 'धातू',
    'Purity': 'शुद्धता',
    'Making': 'मजुरी',
    'Location': 'ठिकाण',
    'Stock': 'साठा',
    'Amount': 'रक्कम',
    'Payment': 'पेमेंट',
    'Payment method': 'पेमेंट प्रकार',
    'Notes': 'टीप',
    'Total in': 'एकूण जमा',
    'Total out': 'एकूण खर्च',
    'Net balance': 'निव्वळ शिल्लक',
    'Money in': 'पैसे जमा',
    'Money out': 'पैसे खर्च',
    'All methods': 'सर्व प्रकार',
    'All': 'सर्व',
    'Active purchases': 'चालू खरेदी',
    'Cancelled purchases': 'रद्द खरेदी',
    'Cancelled': 'रद्द',
    'Active': 'चालू',
    'Available': 'उपलब्ध',
    'Pending': 'प्रलंबित',
    'Paid': 'भरले',
    'Cash': 'रोख',
    'Bank transfer': 'बँक ट्रान्सफर',
    'Card': 'कार्ड',
    'Credit due': 'बाकी रक्कम',
    'Outstanding': 'बाकी',
    'Create Tax Invoice': 'कर बिल तयार करा',
    'Edit Plan': 'योजना बदला',
    'Export Excel': 'Excel निर्यात',
    'Savings Scheme': 'बचत योजना',
    'Enroll Customer': 'ग्राहक नोंदवा',
    'Search customer…': 'ग्राहक शोधा…',
    'Search barcode, invoice, customer…': 'बारकोड, बिल, ग्राहक शोधा…',
    'Search barcode, invoice, customer, URD or scheme': 'बारकोड, बिल, ग्राहक, URD किंवा योजना शोधा',
    'Search by name, mobile number or email': 'नाव, मोबाईल क्रमांक किंवा ईमेलने शोधा',
    'Search name or mobile number…': 'नाव किंवा मोबाईल क्रमांक शोधा…',
    'Search by customer name, mobile number or URD no.': 'ग्राहक नाव, मोबाईल क्रमांक किंवा URD क्रमांकाने शोधा',
    'Search item name or category': 'वस्तूचे नाव किंवा वर्ग शोधा',
    'Type at least 2 characters to search available stock and recent records.': 'उपलब्ध साठा आणि अलीकडील नोंदी शोधण्यासाठी किमान 2 अक्षरे टाइप करा.',
    'Searching…': 'शोधत आहे…',
    'No matching stock or records found.': 'जुळणारा साठा किंवा नोंद आढळली नाही.',
    'Search is temporarily unavailable. Try again.': 'शोध सध्या उपलब्ध नाही. पुन्हा प्रयत्न करा.',
    'Welcome back': 'पुन्हा स्वागत आहे',
    'Username': 'वापरकर्तानाव',
    'Password': 'पासवर्ड',
    'Sign in →': 'साइन इन करा →',
    'Sign in to continue to your ERP workspace.': 'ERP कार्यक्षेत्रात पुढे जाण्यासाठी साइन इन करा.',
    "Set up or change this PC's database connection": 'या संगणकाचे डेटाबेस कनेक्शन सेट करा किंवा बदला',
    'Choose your ERP password': 'ERP पासवर्ड निवडा',
    'Current password': 'सध्याचा पासवर्ड',
    'New password': 'नवीन पासवर्ड',
    'Confirm new password': 'नवीन पासवर्ड पुन्हा टाइप करा',
    'Save password and continue': 'पासवर्ड जतन करून पुढे जा'
  };

  const textNodeAllowed = (node) => {
    const parent = node.parentElement;
    if (!parent) return false;
    if (parent.closest('script, style, code, pre, textarea, input, option, [data-no-i18n], tbody, .barcode-label, .global-search-results')) return false;
    return true;
  };

  const translateTextNodes = (language) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach((node) => {
      if (!textNodeAllowed(node)) return;
      const source = node.__kusumI18nOriginal || node.nodeValue;
      const trimmed = source.trim();
      if (!trimmed || !Object.prototype.hasOwnProperty.call(MARATHI, trimmed)) return;
      if (!node.__kusumI18nOriginal) node.__kusumI18nOriginal = source;
      const original = node.__kusumI18nOriginal;
      const paddingStart = original.match(/^\s*/)?.[0] || '';
      const paddingEnd = original.match(/\s*$/)?.[0] || '';
      node.nodeValue = language === 'mr' ? `${paddingStart}${MARATHI[trimmed]}${paddingEnd}` : original;
    });
  };

  const translateAttributes = (language) => {
    document.querySelectorAll('input[placeholder], textarea[placeholder], [title], [aria-label]').forEach((element) => {
      ['placeholder', 'title', 'aria-label'].forEach((attribute) => {
        if (!element.hasAttribute(attribute) || element.closest('[data-no-i18n]')) return;
        const storageKey = `kusumI18n${attribute.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())}`;
        if (!element.dataset[storageKey]) element.dataset[storageKey] = element.getAttribute(attribute);
        const original = element.dataset[storageKey];
        element.setAttribute(attribute, language === 'mr' && MARATHI[original] ? MARATHI[original] : original);
      });
    });
  };

  const setLanguage = (language) => {
    const selected = language === 'mr' ? 'mr' : 'en';
    translateTextNodes(selected);
    translateAttributes(selected);
    document.documentElement.lang = selected === 'mr' ? 'mr' : 'en';
    document.documentElement.dataset.uiLanguage = selected;
    document.querySelectorAll('[data-ui-language-toggle]').forEach((button) => {
      button.textContent = selected === 'mr' ? 'English' : 'मराठी';
      button.setAttribute('aria-label', selected === 'mr' ? 'Switch ERP interface to English' : 'ERP इंटरफेस मराठीत बदला');
    });
    const divider = document.title.indexOf(' · ');
    if (divider > 0) {
      const first = document.title.slice(0, divider);
      const original = document.documentElement.dataset.i18nTitle || first;
      document.documentElement.dataset.i18nTitle = original;
      document.title = `${selected === 'mr' && MARATHI[original] ? MARATHI[original] : original}${document.title.slice(divider)}`;
    }
    try { localStorage.setItem(STORAGE_KEY, selected); } catch (_) {}
  };

  // Small public helper for UI text inserted later by app.js (for example the
  // asynchronous workspace-search state). It never receives database data.
  window.kusumUiText = (value) => document.documentElement.dataset.uiLanguage === 'mr' && MARATHI[value]
    ? MARATHI[value]
    : value;

  let savedLanguage = 'en';
  try { savedLanguage = localStorage.getItem(STORAGE_KEY) || 'en'; } catch (_) {}
  setLanguage(savedLanguage);
  document.querySelectorAll('[data-ui-language-toggle]').forEach((button) => {
    button.addEventListener('click', () => setLanguage(document.documentElement.dataset.uiLanguage === 'mr' ? 'en' : 'mr'));
  });
})();
