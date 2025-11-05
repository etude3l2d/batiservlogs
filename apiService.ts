/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// This file uses the Firebase compat libraries to make the transition from a different backend smoother.
// FIX: Import Firebase compat libraries to provide types and functionality.
import firebase from 'firebase/compat/app';
import 'firebase/compat/auth';
import 'firebase/compat/firestore';
import 'firebase/compat/storage';


// --- Firebase Initialization ---

// IMPORTANT: Replace with your actual Firebase project configuration
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};

// Initialize Firebase
if (!firebase.apps.length) {
    firebase.initializeApp(firebaseConfig);
}

const auth = firebase.auth();
const db = firebase.firestore();
const storage = firebase.storage();

// --- Data Interfaces ---
// These interfaces remain the same as the UI expects them.
export type UserRole = 'Admin' | 'Editor' | 'Viewer';

export interface User {
  id: string; // This will be the Firebase Auth UID
  name: string;
  email: string;
  role: UserRole;
}

export interface OrderPart {
  number: string;
  isSent: boolean;
  creationDate: string; // ISO string
  userId: string;
  userName: string;
  notes?: string;
}

export interface Order {
  id: string;
  frames: OrderPart | null;
  doors: OrderPart | null;
}

export interface UploadedFile {
  id: string; // Filename in Storage
  name: string; // Original filename
  type: string;
  url: string; // Download URL from Cloud Storage
}

export interface ConstructionSite {
  id: string;
  name: string;
  generalInfo: string;
  generalInfoFiles: UploadedFile[];
  orders: Order[]; // This will be populated from a subcollection
}

export interface Customer {
  id: string;
  name: string;
  sites: ConstructionSite[]; // This will be populated from a subcollection
  notes: string;
}

export interface SpecialOption {
  id: string;
  name: string;
  details: string;
  files: UploadedFile[];
}

export interface SearchResult {
  key: string;
  type: string;
  name: string;
  context?: string;
  customerId?: string;
  siteId?: string;
  optionId?: string;
}

export const CURRENT_USER_KEY = 'batiserv_current_user'; // Keep for session management consistency

// --- Helper Functions ---
const getSubCollection = async (docRef: firebase.firestore.DocumentReference, collectionName: string) => {
    const snapshot = await docRef.collection(collectionName).get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}


// --- API Functions ---

// Authentication

export const login = async (email: string, password_param: string): Promise<User> => {
    const userCredential = await auth.signInWithEmailAndPassword(email, password_param);
    const user = userCredential.user;
    if (!user) {
        throw new Error("Authentication failed.");
    }

    const userDoc = await db.collection('users').doc(user.uid).get();
    if (!userDoc.exists) {
        await auth.signOut();
        throw new Error("User data not found in database. Account may not be fully set up.");
    }

    const userData = { id: user.uid, email: user.email!, ...userDoc.data() } as User;
    
    sessionStorage.setItem(CURRENT_USER_KEY, JSON.stringify(userData));
    
    return userData;
};

export const signup = async (name: string, email: string, password_param: string): Promise<User> => {
    const userCredential = await auth.createUserWithEmailAndPassword(email, password_param);
    const user = userCredential.user;
    if (!user) {
        throw new Error("Could not create user account.");
    }

    const newUser: Omit<User, 'id' | 'email'> = { name, role: 'Viewer' }; // Default role for new signups
    
    await db.collection('users').doc(user.uid).set(newUser);
    
    return { id: user.uid, email, ...newUser };
};

export const recoverPassword = async (email: string): Promise<{ success: boolean }> => {
    await auth.sendPasswordResetEmail(email);
    return { success: true };
};

export const logout = async (): Promise<void> => {
    await auth.signOut();
    sessionStorage.removeItem(CURRENT_USER_KEY);
};

export const getCurrentUser = (): User | null => {
    const userJson = sessionStorage.getItem(CURRENT_USER_KEY);
    return userJson ? JSON.parse(userJson) : null;
};


// Users
export const getUsers = async (): Promise<User[]> => {
    const snapshot = await db.collection('users').get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as User));
};

export const addUser = async (name: string, email: string, password: string, role: UserRole): Promise<User> => {
    throw new Error("Admin user creation requires a backend service for security. Please have new users sign up through the standard registration form.");
};

export const updateUser = async (id: string, updates: Partial<User>): Promise<User | undefined> => {
    const userRef = db.collection('users').doc(id);
    await userRef.update(updates);
    const updatedDoc = await userRef.get();
    return { id: updatedDoc.id, ...updatedDoc.data() } as User;
};

export const deleteUser = async (id: string) => {
    await db.collection('users').doc(id).delete();
    return { success: true };
};

// Customers, Sites, Orders
export const getCustomers = async (): Promise<Customer[]> => {
    const customersSnap = await db.collection('customers').orderBy('name').get();
    
    const customersData = await Promise.all(customersSnap.docs.map(async (customerDoc) => {
        const customer = { id: customerDoc.id, ...customerDoc.data() } as Customer;
        
        const sitesData = await getSubCollection(customerDoc.ref, 'sites');
        customer.sites = await Promise.all(sitesData.map(async (siteData: any) => {
            const site: ConstructionSite = siteData as ConstructionSite;
            const ordersData = await getSubCollection(customerDoc.ref.collection('sites').doc(site.id), 'orders');
            site.orders = ordersData as Order[];
            return site;
        }));
        
        return customer;
    }));
    
    return customersData;
};

export const addCustomer = async (name: string): Promise<Customer> => {
    const newCustomerData = { name, notes: '' };
    const docRef = await db.collection('customers').add(newCustomerData);
    return { id: docRef.id, ...newCustomerData, sites: [] };
};

export const deleteCustomer = async (id: string) => {
    const customerRef = db.collection('customers').doc(id);
    const sitesSnap = await customerRef.collection('sites').get();
    for (const siteDoc of sitesSnap.docs) {
        await deleteSite(id, siteDoc.id);
    }
    await customerRef.delete();
    return { success: true };
};

export const updateCustomer = async (id: string, updates: Partial<Omit<Customer, 'sites'>>): Promise<Customer | undefined> => {
    const customerRef = db.collection('customers').doc(id);
    await customerRef.update(updates);
    const updatedDoc = await customerRef.get();
    return { id: updatedDoc.id, ...updatedDoc.data(), sites: [] } as Customer;
};

export const addSite = async (customerId: string, name: string): Promise<ConstructionSite> => {
    const newSiteData = { name, generalInfo: '', generalInfoFiles: [] };
    const docRef = await db.collection('customers').doc(customerId).collection('sites').add(newSiteData);
    return { id: docRef.id, ...newSiteData, orders: [] };
};

export const deleteSite = async (customerId: string, siteId: string) => {
    const siteRef = db.collection('customers').doc(customerId).collection('sites').doc(siteId);
    const ordersSnap = await siteRef.collection('orders').get();
    const batch = db.batch();
    ordersSnap.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    await siteRef.delete();
    return { success: true };
};

export const updateSite = async (customerId: string, siteId: string, updates: Partial<Omit<ConstructionSite, 'orders'>>): Promise<ConstructionSite | undefined> => {
    const siteRef = db.collection('customers').doc(customerId).collection('sites').doc(siteId);
    await siteRef.update(updates);
    const updatedDoc = await siteRef.get();
    return { id: updatedDoc.id, ...updatedDoc.data(), orders: [] } as ConstructionSite;
};

export const addOrder = async (customerId: string, siteId: string, framesNumber: string, doorsNumber: string, userId: string): Promise<Order[]> => {
    const siteRef = db.collection('customers').doc(customerId).collection('sites').doc(siteId);
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) throw new Error("User not found");
    const user = {id: userDoc.id, ...userDoc.data()} as User;
    
    const newOrders: Order[] = [];
    const batch = db.batch();
    const creationDate = new Date().toISOString();

    const createPart = (number: string): OrderPart => ({
        number, isSent: false, creationDate, userId: user.id, userName: user.name, notes: ''
    });

    if (framesNumber.trim()) {
        const orderRef = siteRef.collection('orders').doc();
        const orderData: Order = { id: orderRef.id, frames: createPart(framesNumber.trim()), doors: null };
        batch.set(orderRef, orderData);
        newOrders.push(orderData);
    }
    if (doorsNumber.trim()) {
        const orderRef = siteRef.collection('orders').doc();
        const orderData: Order = { id: orderRef.id, frames: null, doors: createPart(doorsNumber.trim()) };
        batch.set(orderRef, orderData);
        newOrders.push(orderData);
    }

    await batch.commit();
    return newOrders;
};

export const deleteOrder = async (customerId: string, siteId: string, orderId: string) => {
    await db.collection('customers').doc(customerId).collection('sites').doc(siteId).collection('orders').doc(orderId).delete();
    return { success: true };
};

export const toggleOrderStatus = async (customerId: string, siteId: string, orderId: string, part: 'frames' | 'doors'): Promise<Order | undefined> => {
    const orderRef = db.collection('customers').doc(customerId).collection('sites').doc(siteId).collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();
    const order = orderDoc.data() as Order;
    if (order[part]) {
        await orderRef.update({ [`${part}.isSent`]: !order[part]!.isSent });
        const updatedDoc = await orderRef.get();
        return updatedDoc.data() as Order;
    }
    return order;
};

export const updateOrder = async (customerId: string, siteId: string, orderId: string, part: 'frames' | 'doors', newNumber: string): Promise<Order|undefined> => {
    const orderRef = db.collection('customers').doc(customerId).collection('sites').doc(siteId).collection('orders').doc(orderId);
    await orderRef.update({ [`${part}.number`]: newNumber });
    const updatedDoc = await orderRef.get();
    return updatedDoc.data() as Order;
};

export const updateOrderUser = async (customerId: string, siteId: string, orderId: string, part: 'frames' | 'doors', userId: string): Promise<Order|undefined> => {
    const userDoc = await db.collection('users').doc(userId).get();
    if (!userDoc.exists) throw new Error("User not found");
    const user = userDoc.data() as User;
    const orderRef = db.collection('customers').doc(customerId).collection('sites').doc(siteId).collection('orders').doc(orderId);
    await orderRef.update({
        [`${part}.userId`]: userId,
        [`${part}.userName`]: user.name
    });
    const updatedDoc = await orderRef.get();
    return updatedDoc.data() as Order;
};

export const updateOrderNotes = async (customerId: string, siteId: string, orderId: string, part: 'frames' | 'doors', notes: string): Promise<Order|undefined> => {
    const orderRef = db.collection('customers').doc(customerId).collection('sites').doc(siteId).collection('orders').doc(orderId);
    await orderRef.update({ [`${part}.notes`]: notes });
    const updatedDoc = await orderRef.get();
    return updatedDoc.data() as Order;
};

// Special Options
export const getSpecialOptions = async (): Promise<SpecialOption[]> => {
    const snapshot = await db.collection('specialOptions').orderBy('name').get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as SpecialOption));
};

export const addSpecialOption = async (name: string): Promise<SpecialOption> => {
    const newOptionData = { name, details: '', files: [] };
    const docRef = await db.collection('specialOptions').add(newOptionData);
    return { id: docRef.id, ...newOptionData };
};
export const deleteSpecialOption = async (id: string) => {
    await db.collection('specialOptions').doc(id).delete();
    return { success: true };
};
export const updateSpecialOption = async (id: string, updates: Partial<SpecialOption>): Promise<SpecialOption | undefined> => {
    const optionRef = db.collection('specialOptions').doc(id);
    await optionRef.update(updates);
    const updatedDoc = await optionRef.get();
    return { id: updatedDoc.id, ...updatedDoc.data() } as SpecialOption;
};


// Files (using Cloud Storage)
const uploadFile = async (path: string, file: File): Promise<UploadedFile> => {
    const fileId = `${Date.now()}_${file.name}`;
    const fileRef = storage.ref().child(`${path}/${fileId}`);
    const snapshot = await fileRef.put(file);
    const downloadURL = await snapshot.ref.getDownloadURL();
    return { id: fileId, name: file.name, type: file.type, url: downloadURL };
};

const deleteFileByUrl = async (url: string) => {
    const fileRef = storage.refFromURL(url);
    await fileRef.delete();
};

export const addFileToSite = async (customerId: string, siteId: string, file: File): Promise<UploadedFile> => {
    const uploadedFile = await uploadFile(`sites/${siteId}`, file);
    const siteRef = db.collection('customers').doc(customerId).collection('sites').doc(siteId);
    await siteRef.update({ generalInfoFiles: firebase.firestore.FieldValue.arrayUnion(uploadedFile) });
    return uploadedFile;
};

export const deleteFileFromSite = async (customerId: string, siteId: string, fileId: string) => {
    const siteRef = db.collection('customers').doc(customerId).collection('sites').doc(siteId);
    const doc = await siteRef.get();
    const site = doc.data() as ConstructionSite;
    const fileToDelete = (site.generalInfoFiles || []).find(f => f.id === fileId);
    if (fileToDelete) {
        await deleteFileByUrl(fileToDelete.url);
        await siteRef.update({ generalInfoFiles: firebase.firestore.FieldValue.arrayRemove(fileToDelete) });
    }
    return { success: true };
};

export const addFileToOption = async (optionId: string, file: File): Promise<UploadedFile> => {
    const uploadedFile = await uploadFile(`options/${optionId}`, file);
    const optionRef = db.collection('specialOptions').doc(optionId);
    await optionRef.update({ files: firebase.firestore.FieldValue.arrayUnion(uploadedFile) });
    return uploadedFile;
};

export const deleteFileFromOption = async (optionId: string, fileId: string) => {
    const optionRef = db.collection('specialOptions').doc(optionId);
    const doc = await optionRef.get();
    const option = doc.data() as SpecialOption;
    const fileToDelete = (option.files || []).find(f => f.id === fileId);
    if (fileToDelete) {
        await deleteFileByUrl(fileToDelete.url);
        await optionRef.update({ files: firebase.firestore.FieldValue.arrayRemove(fileToDelete) });
    }
    return { success: true };
};

export const getFileUrl = (file: UploadedFile): string => {
    return file.url;
};

// Data Import
export const importData = async (csvString: string): Promise<{customers: Customer[], users: User[]}> => {
    throw new Error("Data import is a complex backend operation and is not supported in this version. Please contact support.");
};
