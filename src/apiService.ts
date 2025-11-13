/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { initializeApp } from 'firebase/app';
import { getAuth, signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, signOut } from "firebase/auth";
import { getFirestore, collection, getDocs, doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, query, orderBy, where, writeBatch } from 'firebase/firestore';
import { getStorage, ref, uploadBytes, getDownloadURL, deleteObject } from "firebase/storage";
import { firebaseConfig } from './firebase.config';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);
const storage = getStorage(app);

// --- Data Interfaces ---
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
const getSubCollection = async (ref: any, collectionName: string) => {
    const q = query(collection(ref, collectionName));
    const snapshot = await getDocs(q);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}


// --- API Functions ---

// Authentication

export const login = async (email: string, password_param: string): Promise<User> => {
    const userCredential = await signInWithEmailAndPassword(auth, email, password_param);
    const user = userCredential.user;
    if (!user) {
        throw new Error("Authentication failed.");
    }

    const userDocRef = doc(db, 'users', user.uid);
    const userDoc = await getDoc(userDocRef);
    if (!userDoc.exists()) {
        await signOut(auth);
        throw new Error("User data not found in database. Account may not be fully set up.");
    }

    const userData = { id: user.uid, email: user.email!, ...userDoc.data() } as User;
    
    sessionStorage.setItem(CURRENT_USER_KEY, JSON.stringify(userData));
    
    return userData;
};

export const signup = async (name: string, email: string, password_param: string): Promise<User> => {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password_param);
    const user = userCredential.user;
    if (!user) {
        throw new Error("Could not create user account.");
    }

    const newUser: Omit<User, 'id' | 'email'> = { name, role: 'Viewer' }; // Default role for new signups
    
    await setDoc(doc(db, 'users', user.uid), newUser);
    
    return { id: user.uid, email, ...newUser };
};

export const recoverPassword = async (email: string): Promise<{ success: boolean }> => {
    await sendPasswordResetEmail(auth, email);
    return { success: true };
};

export const logout = async (): Promise<void> => {
    await signOut(auth);
    sessionStorage.removeItem(CURRENT_USER_KEY);
};

export const getCurrentUser = (): User | null => {
    const userJson = sessionStorage.getItem(CURRENT_USER_KEY);
    return userJson ? JSON.parse(userJson) : null;
};


// Users
export const getUsers = async (): Promise<User[]> => {
    const usersCol = collection(db, 'users');
    const snapshot = await getDocs(usersCol);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as User));
};

export const addUser = async (name: string, email: string, password: string, role: UserRole): Promise<User> => {
    throw new Error("Admin user creation requires a backend service for security. Please have new users sign up through the standard registration form.");
};

export const updateUser = async (id: string, updates: Partial<User>): Promise<User | undefined> => {
    const userRef = doc(db, 'users', id);
    await updateDoc(userRef, updates);
    const updatedDoc = await getDoc(userRef);
    return { id: updatedDoc.id, ...updatedDoc.data() } as User;
};

export const deleteUser = async (id: string) => {
    await deleteDoc(doc(db, 'users', id));
    return { success: true };
};

// Customers, Sites, Orders
export const getCustomers = async (): Promise<Customer[]> => {
    const customersQuery = query(collection(db, 'customers'), orderBy('name'));
    const customersSnap = await getDocs(customersQuery);
    
    const customersData = await Promise.all(customersSnap.docs.map(async (customerDoc) => {
        const customer = { id: customerDoc.id, ...customerDoc.data() } as Customer;
        
        const sitesData = await getSubCollection(customerDoc.ref, 'sites');
        customer.sites = await Promise.all(sitesData.map(async (siteData: any) => {
            const siteRef = doc(db, customerDoc.ref.path, 'sites', siteData.id);
            const ordersData = await getSubCollection(siteRef, 'orders');
            siteData.orders = ordersData as Order[];
            return siteData as ConstructionSite;
        }));
        
        return customer;
    }));
    
    return customersData;
};

export const addCustomer = async (name: string): Promise<Customer> => {
    const newCustomerData = { name, notes: '' };
    const docRef = await addDoc(collection(db, 'customers'), newCustomerData);
    return { id: docRef.id, ...newCustomerData, sites: [] };
};

export const deleteCustomer = async (id: string) => {
    const customerRef = doc(db, 'customers', id);
    const sitesSnap = await getDocs(collection(customerRef, 'sites'));
    for (const siteDoc of sitesSnap.docs) {
        await deleteSite(id, siteDoc.id);
    }
    await deleteDoc(customerRef);
    return { success: true };
};

export const updateCustomer = async (id: string, updates: Partial<Omit<Customer, 'sites'>>): Promise<Customer | undefined> => {
    const customerRef = doc(db, 'customers', id);
    await updateDoc(customerRef, updates);
    const updatedDoc = await getDoc(customerRef);
    return { id: updatedDoc.id, ...updatedDoc.data(), sites: [] } as Customer;
};

export const addSite = async (customerId: string, name: string): Promise<ConstructionSite> => {
    const newSiteData = { name, generalInfo: '', generalInfoFiles: [] };
    const docRef = await addDoc(collection(db, 'customers', customerId, 'sites'), newSiteData);
    return { id: docRef.id, ...newSiteData, orders: [] };
};

export const deleteSite = async (customerId: string, siteId: string) => {
    const siteRef = doc(db, 'customers', customerId, 'sites', siteId);
    const ordersSnap = await getDocs(collection(siteRef, 'orders'));
    const batch = writeBatch(db);
    ordersSnap.docs.forEach(orderDoc => batch.delete(orderDoc.ref));
    await batch.commit();
    await deleteDoc(siteRef);
    return { success: true };
};

export const updateSite = async (customerId: string, siteId: string, updates: Partial<Omit<ConstructionSite, 'orders'>>): Promise<ConstructionSite | undefined> => {
    const siteRef = doc(db, 'customers', customerId, 'sites', siteId);
    await updateDoc(siteRef, updates);
    const updatedDoc = await getDoc(siteRef);
    return { id: updatedDoc.id, ...updatedDoc.data(), orders: [] } as ConstructionSite;
};

export const addOrder = async (customerId: string, siteId: string, framesNumber: string, doorsNumber: string, userId: string): Promise<Order[]> => {
    const siteRef = doc(db, 'customers', customerId, 'sites', siteId);
    const userDocRef = doc(db, 'users', userId);
    const userDoc = await getDoc(userDocRef);
    if (!userDoc.exists()) throw new Error("User not found");
    const user = {id: userDoc.id, ...userDoc.data()} as User;
    
    const newOrders: Order[] = [];
    const batch = writeBatch(db);
    const creationDate = new Date().toISOString();

    const createPart = (number: string): OrderPart => ({
        number, isSent: false, creationDate, userId: user.id, userName: user.name, notes: ''
    });

    if (framesNumber.trim()) {
        const orderRef = doc(collection(siteRef, 'orders'));
        const orderData: Order = { id: orderRef.id, frames: createPart(framesNumber.trim()), doors: null };
        batch.set(orderRef, orderData);
        newOrders.push(orderData);
    }
    if (doorsNumber.trim()) {
        const orderRef = doc(collection(siteRef, 'orders'));
        const orderData: Order = { id: orderRef.id, frames: null, doors: createPart(doorsNumber.trim()) };
        batch.set(orderRef, orderData);
        newOrders.push(orderData);
    }

    await batch.commit();
    return newOrders;
};

export const deleteOrder = async (customerId: string, siteId: string, orderId: string) => {
    await deleteDoc(doc(db, 'customers', customerId, 'sites', siteId, 'orders', orderId));
    return { success: true };
};

export const toggleOrderStatus = async (customerId: string, siteId: string, orderId: string, part: 'frames' | 'doors'): Promise<Order | undefined> => {
    const orderRef = doc(db, 'customers', customerId, 'sites', siteId, 'orders', orderId);
    const orderDoc = await getDoc(orderRef);
    const order = orderDoc.data() as Order;
    if (order[part]) {
        await updateDoc(orderRef, { [`${part}.isSent`]: !order[part]!.isSent });
        const updatedDoc = await getDoc(orderRef);
        return updatedDoc.data() as Order;
    }
    return order;
};

export const updateOrder = async (customerId: string, siteId: string, orderId: string, part: 'frames' | 'doors', newNumber: string): Promise<Order|undefined> => {
    const orderRef = doc(db, 'customers', customerId, 'sites', siteId, 'orders', orderId);
    await updateDoc(orderRef, { [`${part}.number`]: newNumber });
    const updatedDoc = await getDoc(orderRef);
    return updatedDoc.data() as Order;
};

export const updateOrderUser = async (customerId: string, siteId: string, orderId: string, part: 'frames' | 'doors', userId: string): Promise<Order|undefined> => {
    const userDocRef = doc(db, 'users', userId);
    const userDoc = await getDoc(userDocRef);
    if (!userDoc.exists()) throw new Error("User not found");
    const user = userDoc.data() as User;
    const orderRef = doc(db, 'customers', customerId, 'sites', siteId, 'orders', orderId);
    await updateDoc(orderRef, {
        [`${part}.userId`]: userId,
        [`${part}.userName`]: user.name
    });
    const updatedDoc = await getDoc(orderRef);
    return updatedDoc.data() as Order;
};

export const updateOrderNotes = async (customerId: string, siteId: string, orderId: string, part: 'frames' | 'doors', notes: string): Promise<Order|undefined> => {
    const orderRef = doc(db, 'customers', customerId, 'sites', siteId, 'orders', orderId);
    await updateDoc(orderRef, { [`${part}.notes`]: notes });
    const updatedDoc = await getDoc(orderRef);
    return updatedDoc.data() as Order;
};

// Special Options
export const getSpecialOptions = async (): Promise<SpecialOption[]> => {
    const optionsQuery = query(collection(db, 'specialOptions'), orderBy('name'));
    const snapshot = await getDocs(optionsQuery);
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as SpecialOption));
};

export const addSpecialOption = async (name: string): Promise<SpecialOption> => {
    const newOptionData = { name, details: '', files: [] };
    const docRef = await addDoc(collection(db, 'specialOptions'), newOptionData);
    return { id: docRef.id, ...newOptionData };
};
export const deleteSpecialOption = async (id: string) => {
    await deleteDoc(doc(db, 'specialOptions', id));
    return { success: true };
};
export const updateSpecialOption = async (id: string, updates: Partial<SpecialOption>): Promise<SpecialOption | undefined> => {
    const optionRef = doc(db, 'specialOptions', id);
    await updateDoc(optionRef, updates);
    const updatedDoc = await getDoc(optionRef);
    return { id: updatedDoc.id, ...updatedDoc.data() } as SpecialOption;
};


// Files (using Cloud Storage)
const uploadFile = async (path: string, file: File): Promise<UploadedFile> => {
    const fileId = `${Date.now()}_${file.name}`;
    const fileRef = ref(storage, `${path}/${fileId}`);
    const snapshot = await uploadBytes(fileRef, file);
    const downloadURL = await getDownloadURL(snapshot.ref);
    return { id: fileId, name: file.name, type: file.type, url: downloadURL };
};

const deleteFileByUrl = async (url: string) => {
    const fileRef = ref(storage, url);
    await deleteObject(fileRef);
};

export const addFileToSite = async (customerId: string, siteId: string, file: File): Promise<UploadedFile> => {
    const uploadedFile = await uploadFile(`sites/${siteId}`, file);
    const siteRef = doc(db, 'customers', customerId, 'sites', siteId);
    const siteDoc = await getDoc(siteRef);
    const siteData = siteDoc.data();
    const existingFiles = siteData?.generalInfoFiles || [];
    await updateDoc(siteRef, { generalInfoFiles: [...existingFiles, uploadedFile] });
    return uploadedFile;
};

export const deleteFileFromSite = async (customerId: string, siteId: string, fileId: string) => {
    const siteRef = doc(db, 'customers', customerId, 'sites', siteId);
    const docSnap = await getDoc(siteRef);
    const site = docSnap.data() as ConstructionSite;
    const fileToDelete = (site.generalInfoFiles || []).find(f => f.id === fileId);
    if (fileToDelete) {
        await deleteFileByUrl(fileToDelete.url);
        const updatedFiles = site.generalInfoFiles.filter(f => f.id !== fileId);
        await updateDoc(siteRef, { generalInfoFiles: updatedFiles });
    }
    return { success: true };
};

export const addFileToOption = async (optionId: string, file: File): Promise<UploadedFile> => {
    const uploadedFile = await uploadFile(`options/${optionId}`, file);
    const optionRef = doc(db, 'specialOptions', optionId);
    const docSnap = await getDoc(optionRef);
    const optionData = docSnap.data();
    const existingFiles = optionData?.files || [];
    await updateDoc(optionRef, { files: [...existingFiles, uploadedFile] });
    return uploadedFile;
};

export const deleteFileFromOption = async (optionId: string, fileId: string) => {
    const optionRef = doc(db, 'specialOptions', optionId);
    const docSnap = await getDoc(optionRef);
    const option = docSnap.data() as SpecialOption;
    const fileToDelete = (option.files || []).find(f => f.id === fileId);
    if (fileToDelete) {
        await deleteFileByUrl(fileToDelete.url);
        const updatedFiles = option.files.filter(f => f.id !== fileId);
        await updateDoc(optionRef, { files: updatedFiles });
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